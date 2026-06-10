"""
Oracle AI Analysis Service
Generates AI-driven analysis for Oracle errors
"""

def analyze_oracle_error(error_message: str, error_code: str, engine=None) -> str:
    """
    Analyze Oracle error and provide AI-driven insights
    """
    
    error_msg_lower = error_message.lower()
    error_code_int = int(error_code) if error_code.isdigit() else 0
    
    analysis = f"""
Oracle Error Analysis Report
============================

What is error:
Oracle reported error code {error_code}: {error_message}

"""
    
    if error_code_int == 1:
        analysis += """Why it is coming:
Unique constraint violated. An attempt was made to insert or update a row with a duplicate value
in a column that has a unique constraint.

How to solve:
1. Identify which constraint was violated
2. Check the existing data for duplicate values
3. Modify the data to remove duplicates
4. Use UPSERT (MERGE) if appropriate
5. Review application logic for proper data validation

Exactly where to change:
Review and update the INSERT/UPDATE statements in your application.
Check the database schema for constraint definitions.

Exact variable to remove:
No configuration variable needs removal - fix the data issue instead.
"""
    elif error_code_int == 54:
        analysis += """Why it is coming:
Resource busy or temporarily unavailable. Another session has locked the resource you're trying to access.

How to solve:
1. Wait for the other transaction to complete
2. Check for blocking locks using v$session and v$lock
3. Kill blocking sessions if necessary
4. Optimize transaction scope to reduce lock duration
5. Consider using row-level locking instead of table locks
6. Implement proper transaction isolation levels

Exactly where to change:
Review your application's transaction management.
Optimize query performance to reduce lock contention.

Exact variable to remove:
No configuration variable removal needed.
"""
    elif error_code_int == 1017:
        analysis += """Why it is coming:
Invalid username/password or user not found. Authentication failed for the specified user.

How to solve:
1. Verify the username is correct
2. Reset the password if needed
3. Check if the user account is locked
4. Ensure the user has appropriate privileges
5. Verify the database link credentials

Exactly where to change:
Update the connection credentials in your application.
Reset the user password in Oracle if needed.

Exact variable to remove:
No configuration variable removal needed.
"""
    else:
        analysis += """Why it is coming:
The specific error requires analysis of the Oracle error logs and server state.

How to solve:
1. Check the Oracle alert log and trace files
2. Review the error message in Oracle documentation
3. Check database initialization parameters
4. Verify tablespace availability
5. Check for library cache issues

Exactly where to change:
Refer to the Oracle error logs for specific guidance.

Exact variable to remove:
No configuration variable removal needed.
"""
    
    return analysis.strip()
