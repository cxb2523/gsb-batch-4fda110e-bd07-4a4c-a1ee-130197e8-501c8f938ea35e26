# Sets up webhook to send notifications to Discord.
#
# ``notify`` only ever receives the normalized, deduplicated new-job set.
# The HTTP call goes through an injectable ``poster`` so tests can capture
# payloads without touching a real webhook.

import os
import time

import requests
from dotenv import load_dotenv

load_dotenv()

DISCORD_WEBHOOK = os.getenv("DISCORD_WEBHOOK")


def _default_poster(webhook_url: str, payload: dict) -> None:
    requests.post(webhook_url, json=payload)


def notify(
    job_list: list,
    webhook_url: str | None = None,
    poster=None,
    sleep=time.sleep,
) -> int:
    """Push each normalized new job to Discord.

    Returns the number of jobs pushed. ``poster`` and ``sleep`` are
    injectable seams used by tests to avoid real network calls and waits.
    """
    if len(job_list) == 0:
        print("[NOTIFICATION] No new jobs found.")
        return 0

    url = webhook_url if webhook_url is not None else DISCORD_WEBHOOK
    if not url:
        raise ValueError("DISCORD_WEBHOOK is not configured.")
    poster = poster or _default_poster

    for job in job_list:
        poster(
            url,
            {
                "embeds": [
                    {
                        "title": "🎯 New Job Found!",
                        "description": (
                            f"**{job['company']}**\n"
                            f"[{job['title']}]({job['link']})"
                        ),
                    }
                ]
            },
        )
        sleep(0.4)  # To avoid hitting rate limits

    num_jobs = len(job_list)
    if num_jobs == 1:
        print("[NOTIFICATION] Sent 1 new job to Discord.")
    else:
        print(f"[NOTIFICATION] Sent {num_jobs} new jobs to Discord.")
    return num_jobs
