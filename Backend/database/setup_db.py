import psycopg2

try:
    conn = psycopg2.connect(
        host="localhost",
        port=5432,
        user="sa",
        password="Actin@#2931",
        dbname="postgres"
    )
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM pg_database WHERE datname='actmon'")
    exists = cur.fetchone()
    if not exists:
        cur.execute("CREATE DATABASE actmon")
        print("Created database: actmon")
    else:
        print("Database actmon already exists")
    cur.close()
    conn.close()
    print("PostgreSQL connection OK - sa@localhost:5432")
except Exception as e:
    print(f"ERROR: {e}")
