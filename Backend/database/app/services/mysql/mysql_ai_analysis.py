from groq import Groq
from dotenv import load_dotenv

import os
import json

# =====================================================
# LOAD ENV
# =====================================================

load_dotenv()

# =====================================================
# GROQ CLIENT
# =====================================================

client = Groq(

    api_key=os.getenv(
        "GROQ_API_KEY"
    )

)

# =====================================================
# MYSQL AI ANALYSIS
# =====================================================

def analyze_mysql_error(error_log):

    prompt = f"""
You are an Expert Senior MySQL DBA AI.

Analyze this MySQL error deeply.

Return ONLY valid JSON.

DO NOT return markdown.

DO NOT use ** or ###.


STRICT JSON FORMAT:

{{
  "severity": "CRITICAL | ERROR | WARNING | INFO",
  "error_summary": "Short user-friendly description of the error",
  "root_cause": "A concise explanation of what the technical root cause is",
  "why_happening": "An explanation of why this error occurred in the system environment",
  "business_impact": "Operational or performance impact this error might have on the business",
  "dba_recommendation": "The expert DBA recommendation to address this issue",
  "prevention": "Best practices or steps to prevent this error from recurring",
  "sql_validation_queries": [
    "SQL statements that a DBA can run to verify current configuration or status"
  ],
  "infrastructure_analysis": "Infrastructure-level analysis of CPU/disk/memory or network relation to this error",
  "immediate_action": [
    "Step-by-step immediate manual action list to mitigate"
  ],
  "affected_file": "Configuration or log file path/name that is causing the problem, e.g. 'my.ini' or 'my.cnf'",
  "exact_change_location": "The section or line where changes are needed, e.g. '[mysqld] section' or 'system service config'",
  "values_before": "The offending configuration line or state before remediation, e.g. 'invalid_parameter = xyz' or 'max_connections = 151'",
  "values_after": "The corrected configuration line or state after remediation, e.g. '[REMOVED]' or 'max_connections = 500'",
  "self_healing_steps": [
    "A sequence of short text instructions showing what the automated self-healing system will execute (e.g. 'Backup config file', 'Remove variable', 'Restart service')"
  ],
  
}}

MySQL Error:

{error_log}
"""

    response = client.chat.completions.create(

        model="llama-3.3-70b-versatile",

        messages=[
            {
                "role": "user",
                "content": prompt
            }
        ],

        temperature=0.1,

        max_tokens=1500

    )

    content = response.choices[0].message.content

    try:

        return json.loads(content)

    except Exception:

        return {

            "severity": "UNKNOWN",
            "error_summary": "Failed to parse AI analysis payload",
            "root_cause": content,
            "why_happening": "AI response did not match JSON structure or failed to parse.",
            "business_impact": "Analysis parsing failed",
            "dba_recommendation": "Review manually",
            "prevention": "Check API logs or retry analysis",
            "sql_validation_queries": [],
            "infrastructure_analysis": content,
            "immediate_action": [],
            "affected_file": "Unknown / System Config",
            "exact_change_location": "N/A",
            "values_before": "N/A",
            "values_after": "N/A",
            "self_healing_steps": ["Verify database service status", "Check error log manually"],
            

        }