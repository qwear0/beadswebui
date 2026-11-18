"""Dagster 1.13 code location definitions for the Dashboard worker."""

from dagster import DefaultSensorStatus, Definitions, Field, RunRequest, SkipReason, String, job, op, sensor

from .worker import invite_ids, run_invitation


@op(config_schema={"invitation": Field(String)})
def process_invitation(context) -> None:
    # The invitation UUID is the only run-config value; claim data and payloads
    # are fetched after run start and never emitted as Dagster metadata.
    run_invitation(context.op_config["invitation"])


@job
def dashboard_worker_job():
    process_invitation()


@sensor(
    job=dashboard_worker_job,
    minimum_interval_seconds=30,
    default_status=DefaultSensorStatus.STOPPED,
)
def dashboard_invitation_sensor(_context):
    invitations = invite_ids()
    if not invitations:
        yield SkipReason("No Dashboard invitations")
        return
    for invitation in invitations:
        # Run keys are finite queue-issued invitation UUIDs, never event IDs.
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
