import sys
sys.path.insert(0, 'E:/ACTMON V1/Backend/database')
from app.database.connection import engine
from sqlalchemy import text

with engine.connect() as conn:
    res = conn.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name='connection_master' "
        "AND column_name IN ('ssh_host','ssh_port','ssh_user','ssh_password')"
    )).fetchall()
    existing = [r[0] for r in res]
    print('Existing SSH cols:', existing)

    for col, typ in [
        ('ssh_host', 'VARCHAR(500)'),
        ('ssh_port', 'INTEGER'),
        ('ssh_user', 'VARCHAR(255)'),
        ('ssh_password', 'VARCHAR(500)'),
    ]:
        if col not in existing:
            conn.execute(text(f'ALTER TABLE connection_master ADD COLUMN {col} {typ}'))
            print(f'Added: {col}')
        else:
            print(f'Already exists: {col}')

    conn.commit()
    print('Migration done.')
