"""Dagster 1.13 code location definitions for the Dashboard worker."""

from dagster import DefaultSensorStatus, Definitions, Field, RetryPolicy, RunRequest, SkipReason, String, job, op, sensor

from .worker import invite_ids, run_invitation


@op(config_schema={"invitation": Field(String)}, retry_policy=RetryPolicy(max_retries=0))
def process_invitation(context) -> None:
    # The invitation token is the only run-config value; claim data and payloads
    # are fetched after run start and never emitted as Dagster metadata.
    run_invitation(context.op_config["invitation"])


@job(tags={"dagster/max_retries": "0"})
def dashboard_worker_job():
    process_invitation()


@sensor(
    job=dashboard_worker_job,
    minimum_interval_seconds=5,
    default_status=DefaultSensorStatus.STOPPED,
)
def dashboard_invitation_sensor(_context):
    invitations = invite_ids()
    if not invitations:
        yield SkipReason("No Dashboard invitations")
        return
    for invitation in invitations:
        # Run keys are queue-issued invitation tokens, never event IDs.
        yield RunRequest(
            run_key=invitation,
            run_config={
                "ops": {
                    "process_invitation": {
                        "config": {"invitation": invitation},
                    },
                },
            },
        )


definitions = Definitions(
    jobs=[dashboard_worker_job],
    sensors=[dashboard_invitation_sensor],
)
