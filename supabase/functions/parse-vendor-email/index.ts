import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
// @deno-types="npm:openai@4.20.1"
import OpenAI from "npm:openai@4.20.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ParsedVendorEmail {
  job_title: string;
  client_company: string | null;
  location: string | null;
  work_arrangement: 'onsite' | 'remote' | 'hybrid' | 'unknown';
  employment_type: 'w2' | 'c2c' | '1099' | 'full_time' | 'contract' | 'contract_to_hire' | 'part_time' | 'unknown';
  duration: string | null;
  pay_rate: string | null;
  pay_rate_min: number | null;
  pay_rate_max: number | null;
  pay_rate_type: string | null;
  required_skills: string[];
  years_experience: string | null;
  certifications: string[];
  special_requirements: string | null;
  tech_stack: Record<string, string[]>;
  job_description: string | null;
  recruiter_name: string | null;
  recruiter_email: string | null;
  recruiter_phone: string | null;
  recruiter_title: string | null;
  vendor_company: string | null;
  extraction_confidence: number;
  extraction_errors: string[];
}

// Extract email address from "From" field
function parseEmailFrom(from: string): { name: string; email: string } {
  const emailMatch = from.match(/<([^>]+)>/);
  if (emailMatch) {
    const email = emailMatch[1];
    const name = from.replace(/<[^>]+>/, '').trim();
    return { name, email };
  }
  // If no angle brackets, assume it's just an email
  return { name: '', email: from.trim() };
}

// Extract phone number from text
function extractPhoneNumber(text: string): string | null {
  const phonePatterns = [
    /\+?1?\s*[-.]?\s*\(?(\d{3})\)?[-.\s]*(\d{3})[-.\s]*(\d{4})(?:\s*(?:ext|x|extension)\.?\s*(\d+))?/gi,
    /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  ];

  for (const pattern of phonePatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0].trim();
    }
  }
  return null;
}

// Extract vendor company name from email domain
function extractVendorCompany(email: string): string | null {
  const domain = email.split('@')[1];
  if (!domain) return null;

  // Remove common TLDs and clean up
  const companyPart = domain.split('.')[0];
  return companyPart.charAt(0).toUpperCase() + companyPart.slice(1);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("Missing authorization header");
    }

    const { emailBody, emailSubject, emailFrom, emailReceivedAt, emailId } = await req.json();

    if (!emailBody) {
      throw new Error("Email body is required");
    }

    // Parse the from field
    const fromParsed = parseEmailFrom(emailFrom || '');

    // Initialize OpenAI
    const openai = new OpenAI({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    });

    const systemPrompt = `You are an expert at extracting job information from recruiter/vendor emails.
These emails typically come from staffing agencies and contain job opportunities with details about:
- The position (title, tech stack, requirements)
- The client company (the actual employer)
- The staffing company (vendor)
- Compensation details
- Location and work arrangement
- Recruiter contact information

Extract all relevant information accurately. Return ONLY valid JSON.`;

    const userPrompt = `Extract job information from this vendor/recruiter email. Return a JSON object with these fields:

{
  "job_title": "string - exact job title",
  "client_company": "string or null - the actual client/employer (e.g., Capital One), NOT the staffing agency",
  "location": "string or null - full location",
  "work_arrangement": "remote" | "hybrid" | "onsite" | "unknown",
  "employment_type": "w2" | "c2c" | "1099" | "full_time" | "contract" | "contract_to_hire" | "part_time" | "unknown",
  "duration": "string or null - contract duration like 'Long term', '6 months', etc.",
  "pay_rate": "string or null - original pay rate text",
  "pay_rate_min": "number or null - minimum hourly/annual rate",
  "pay_rate_max": "number or null - maximum hourly/annual rate",
  "pay_rate_type": "hourly" | "annual" | "monthly" | null,
  "required_skills": ["array of required skills/technologies"],
  "years_experience": "string or null - like '3-5 years' or '5+ years'",
  "certifications": ["array of required certifications"],
  "special_requirements": "string or null - any special requirements like 'Ex-Capital One Only', 'Must have security clearance', etc.",
  "tech_stack": {
    "frontend": ["Vue.js", "React"],
    "backend": ["Python", "Java"],
    "cloud": ["AWS", "ECS"],
    "other": ["Docker"]
  },
  "job_description": "string or null - extracted job description/responsibilities",
  "recruiter_name": "string or null - the recruiter's name",
  "recruiter_email": "string or null - recruiter's email address",
  "recruiter_phone": "string or null - recruiter's phone number",
  "recruiter_title": "string or null - recruiter's job title",
  "vendor_company": "string or null - the staffing/consulting company name (NOT the client)",
  "extraction_confidence": "number 0-1 - how confident in the extraction",
  "extraction_errors": ["array of any issues encountered during extraction"]
}

Email Subject: ${emailSubject || 'Not provided'}
Email From: ${emailFrom || 'Not provided'}

Email Body:
${emailBody}

Return ONLY the JSON object, no other text.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response from AI");
    }

    let parsedData: ParsedVendorEmail;
    try {
      parsedData = JSON.parse(content);
    } catch (parseError) {
      console.error("Failed to parse response:", content);
      throw new Error("Failed to parse AI response as JSON");
    }

    // Validate we got meaningful data
    if (!parsedData.job_title) {
      throw new Error("Could not extract job title from email");
    }

    // Enrich with additional data extraction
    if (!parsedData.recruiter_phone) {
      parsedData.recruiter_phone = extractPhoneNumber(emailBody);
    }

    if (!parsedData.vendor_company && fromParsed.email) {
      parsedData.vendor_company = extractVendorCompany(fromParsed.email);
    }

    if (!parsedData.recruiter_name && fromParsed.name) {
      parsedData.recruiter_name = fromParsed.name;
    }

    if (!parsedData.recruiter_email && fromParsed.email) {
      parsedData.recruiter_email = fromParsed.email;
    }

    // Initialize Supabase client to save the data
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get user ID from auth header
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      throw new Error("Invalid authorization token");
    }

    // Check if vendor exists, create if not
    let vendorId = null;
    if (parsedData.vendor_company) {
      const { data: existingVendor } = await supabase
        .from('vendors')
        .select('id')
        .eq('user_id', user.id)
        .eq('company_name', parsedData.vendor_company)
        .single();

      if (existingVendor) {
        vendorId = existingVendor.id;
        // Update emails received count
        await supabase
          .from('vendors')
          .update({
            emails_received: supabase.rpc('increment', { row_id: vendorId, increment_amount: 1 }),
            jobs_posted: supabase.rpc('increment', { row_id: vendorId, increment_amount: 1 })
          })
          .eq('id', vendorId);
      } else {
        const { data: newVendor, error: vendorError } = await supabase
          .from('vendors')
          .insert({
            user_id: user.id,
            company_name: parsedData.vendor_company,
            emails_received: 1,
            jobs_posted: 1
          })
          .select('id')
          .single();

        if (!vendorError && newVendor) {
          vendorId = newVendor.id;
        }
      }
    }

    // Check if vendor contact exists, create if not
    let vendorContactId = null;
    if (vendorId && parsedData.recruiter_email) {
      const { data: existingContact } = await supabase
        .from('vendor_contacts')
        .select('id')
        .eq('vendor_id', vendorId)
        .eq('email', parsedData.recruiter_email)
        .single();

      if (existingContact) {
        vendorContactId = existingContact.id;
        // Update contact
        await supabase
          .from('vendor_contacts')
          .update({
            last_contact_at: new Date().toISOString(),
            emails_sent: supabase.rpc('increment', { row_id: vendorContactId, increment_amount: 1 })
          })
          .eq('id', vendorContactId);
      } else {
        const { data: newContact, error: contactError } = await supabase
          .from('vendor_contacts')
          .insert({
            vendor_id: vendorId,
            user_id: user.id,
            name: parsedData.recruiter_name || 'Unknown',
            email: parsedData.recruiter_email,
            phone: parsedData.recruiter_phone,
            title: parsedData.recruiter_title,
            emails_sent: 1,
            last_contact_at: new Date().toISOString()
          })
          .select('id')
          .single();

        if (!contactError && newContact) {
          vendorContactId = newContact.id;
        }
      }
    }

    // Save the vendor job email
    const { data: savedJob, error: saveError } = await supabase
      .from('vendor_job_emails')
      .insert({
        user_id: user.id,
        vendor_id: vendorId,
        vendor_contact_id: vendorContactId,
        email_id: emailId,
        email_subject: emailSubject,
        email_from: emailFrom,
        email_received_at: emailReceivedAt || new Date().toISOString(),
        email_body_raw: emailBody,
        job_title: parsedData.job_title,
        client_company: parsedData.client_company,
        location: parsedData.location,
        work_arrangement: parsedData.work_arrangement || 'unknown',
        employment_type: parsedData.employment_type || 'unknown',
        duration: parsedData.duration,
        pay_rate: parsedData.pay_rate,
        pay_rate_min: parsedData.pay_rate_min,
        pay_rate_max: parsedData.pay_rate_max,
        pay_rate_type: parsedData.pay_rate_type,
        required_skills: parsedData.required_skills || [],
        years_experience: parsedData.years_experience,
        certifications: parsedData.certifications || [],
        special_requirements: parsedData.special_requirements,
        tech_stack: parsedData.tech_stack || {},
        job_description: parsedData.job_description,
        recruiter_name: parsedData.recruiter_name,
        recruiter_email: parsedData.recruiter_email,
        recruiter_phone: parsedData.recruiter_phone,
        recruiter_title: parsedData.recruiter_title,
        extraction_confidence: parsedData.extraction_confidence || 0.8,
        extraction_errors: parsedData.extraction_errors || [],
        status: 'new'
      })
      .select()
      .single();

    if (saveError) {
      console.error("Error saving job:", saveError);
      throw new Error(`Failed to save job: ${saveError.message}`);
    }

    return new Response(JSON.stringify({
      success: true,
      job: savedJob,
      parsed: parsedData
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
});
