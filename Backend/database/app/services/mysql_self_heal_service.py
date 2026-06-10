from datetime import datetime
import json
import os
import uuid

from app.services.mysql_ai_analysis import (
    analyze_mysql_error
)

from app.services.mysql_config_service import (
    backup_mysql_config,
    remove_mysql_variable
)

from app.services.mysql_service_manager import (
    start_mysql_service,
    get_mysql_service_status,
    kill_process_by_pid
)

from app.services.mysql_health_service import (
    get_latest_mysql_error_logs,
    is_mysql_running,
    get_mysql_port_pid
)


HISTORY_DIR = os.path.join(
    os.path.dirname(
        os.path.dirname(__file__)
    ),
    "data",
    "mysql_self_heal_history"
)


def timestamp():

    return datetime.now().strftime(
        "%Y-%m-%d %H:%M:%S"
    )


def append_result(
    logs,
    command_results,
    label,
    result
):

    command_results.append({
        "label": label,
        **result
    })

    logs.append(
        f"[{timestamp()}] [COMMAND] {label}: "
        f"{result.get('command', 'N/A')}"
    )

    if result.get("output"):

        logs.append(
            f"[{timestamp()}] [OUTPUT] "
            f"{result.get('output')}"
        )

    if result.get("error"):

        logs.append(
            f"[{timestamp()}] [WARNING] "
            f"{result.get('error')}"
        )

    if result.get("message"):

        logs.append(
            f"[{timestamp()}] [ERROR] "
            f"{result.get('message')}"
        )


def save_history(record):

    os.makedirs(
        HISTORY_DIR,
        exist_ok=True
    )

    history_path = os.path.join(
        HISTORY_DIR,
        f"{record['run_id']}.json"
    )

    with open(
        history_path,
        "w",
        encoding="utf-8"
    ) as f:

        json.dump(
            record,
            f,
            indent=2,
            default=str
        )

    return history_path


def finish_record(record):

    history_path = save_history(
        record
    )

    record["history_path"] = history_path

    return record


def run_diagnose_only(
    connection,
    logs,
    command_results
):

    logs.append(
        f"[{timestamp()}] [INFO] "
        f"Diagnosis-only mode. No write, kill, restart, or schema change will run."
    )

    status_result = get_mysql_service_status(
        connection.host
    )

    append_result(
        logs,
        command_results,
        "Check MySQL service status",
        status_result
    )

    error_logs = get_latest_mysql_error_logs(
        connection.host
    )

    append_result(
        logs,
        command_results,
        "Read latest MySQL error log",
        error_logs
    )


def run_mysql_self_heal(
    connection,
    mysql_error_message
):

    run_id = (
        datetime.now().strftime("%Y%m%d%H%M%S")
        + "-"
        + uuid.uuid4().hex[:8]
    )

    logs = []

    command_results = []

    logs.append(
        f"[{timestamp()}] [INFO] "
        f"ACTMON self-healing engine started."
    )

    logs.append(
        f"[{timestamp()}] [INFO] "
        f"Run ID: {run_id}"
    )

    logs.append(
        f"[{timestamp()}] [INFO] "
        f"Target Host: {connection.host}"
    )

    logs.append(
        f"[{timestamp()}] [INFO] "
        f"Running AI error analysis..."
    )

    analysis = analyze_mysql_error(
        mysql_error_message
    )

    logs.append(
        f"[{timestamp()}] [SUCCESS] "
        f"AI analysis completed."
    )

    action = analysis.get(
        "self_healing_actions",
        {}
    )

    action_type = action.get(
        "action_type",
        "diagnose_only"
    )

    target_variable = action.get(
        "target_variable",
        ""
    )

    safe_to_auto_heal = bool(
        analysis.get(
            "safe_to_auto_heal",
            False
        )
    )

    logs.append(
        f"[{timestamp()}] [INFO] "
        f"Detected Action Type: {action_type}"
    )

    logs.append(
        f"[{timestamp()}] [INFO] "
        f"Target Variable: {target_variable}"
    )

    logs.append(
        f"[{timestamp()}] [INFO] "
        f"Safe To Auto Heal: {safe_to_auto_heal}"
    )

    if (
        action_type == "no_action"
        or analysis.get("severity") == "INFO"
    ):

        logs.append(
            f"[{timestamp()}] [SUCCESS] "
            f"No self-healing action required."
        )

        return finish_record({
            "run_id": run_id,
            "status": "success",
            "host": connection.host,
            "action_type": "no_action",
            "logs": logs,
            "commands": command_results,
            "analysis": analysis
        })

    if (
        action_type == "diagnose_only"
        or not safe_to_auto_heal
    ):

        run_diagnose_only(
            connection,
            logs,
            command_results
        )

    elif action_type == "kill_port_process":

        logs.append(
            f"[{timestamp()}] [INFO] "
            f"Checking port 3306 conflicts..."
        )

        pid = get_mysql_port_pid(
            connection.host
        )

        if pid:

            logs.append(
                f"[{timestamp()}] [WARNING] "
                f"Port 3306 occupied by PID: {pid}"
            )

            kill_result = kill_process_by_pid(
                connection.host,
                pid
            )

            append_result(
                logs,
                command_results,
                "Kill conflicting port process",
                kill_result
            )

        else:

            logs.append(
                f"[{timestamp()}] [SUCCESS] "
                f"No conflicting PID found."
            )

    elif action_type == "remove_variable":

        if not target_variable:

            logs.append(
                f"[{timestamp()}] [ERROR] "
                f"Target variable is empty. Config edit skipped."
            )

        else:

            logs.append(
                f"[{timestamp()}] [INFO] "
                f"Creating timestamped MySQL configuration backup..."
            )

            backup_result = backup_mysql_config(
                connection.host
            )

            append_result(
                logs,
                command_results,
                "Backup MySQL configuration",
                backup_result
            )

            logs.append(
                f"[{timestamp()}] [INFO] "
                f"Removing exact invalid variable line..."
            )

            remove_result = remove_mysql_variable(
                connection.host,
                target_variable
            )

            append_result(
                logs,
                command_results,
                "Remove invalid MySQL variable",
                remove_result
            )

            status_before_start = get_mysql_service_status(
                connection.host
            )

            append_result(
                logs,
                command_results,
                "Check service status before start",
                status_before_start
            )

            if "RUNNING" not in status_before_start.get(
                "output",
                ""
            ):

                start_result = start_mysql_service(
                    connection.host
                )

                append_result(
                    logs,
                    command_results,
                    "Start MySQL service",
                    start_result
                )

            else:

                logs.append(
                    f"[{timestamp()}] [SUCCESS] "
                    f"MySQL service already running. Restart skipped."
                )

    elif action_type == "start_mysql":

        start_result = start_mysql_service(
            connection.host
        )

        append_result(
            logs,
            command_results,
            "Start MySQL service",
            start_result
        )

    else:

        logs.append(
            f"[{timestamp()}] [WARNING] "
            f"No safe predefined remediation found. Running diagnostics only."
        )

        run_diagnose_only(
            connection,
            logs,
            command_results
        )

    logs.append(
        f"[{timestamp()}] [INFO] "
        f"Verifying MySQL service status..."
    )

    status_result = get_mysql_service_status(
        connection.host
    )

    append_result(
        logs,
        command_results,
        "Final MySQL service status",
        status_result
    )

    mysql_running = is_mysql_running(
        connection.host
    )

    if mysql_running:

        logs.append(
            f"[{timestamp()}] [SUCCESS] "
            f"MySQL service is RUNNING."
        )

    else:

        logs.append(
            f"[{timestamp()}] [ERROR] "
            f"MySQL service is still DOWN."
        )

        error_logs = get_latest_mysql_error_logs(
            connection.host
        )

        append_result(
            logs,
            command_results,
            "Read latest MySQL error log after failure",
            error_logs
        )

    return finish_record({
        "run_id": run_id,
        "status": (
            "success"
            if mysql_running
            else "failed"
        ),
        "host": connection.host,
        "action_type": action_type,
        "logs": logs,
        "commands": command_results,
        "analysis": analysis
    })
