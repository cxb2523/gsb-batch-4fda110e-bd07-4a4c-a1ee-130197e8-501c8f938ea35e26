# Sets up webhook to send notifications to Discord

import os
import time
import requests
from dotenv import load_dotenv

load_dotenv()

DISCORD_WEBHOOK = os.getenv("DISCORD_WEBHOOK")


def notify(job_list: list) -> None:

    if len(job_list) == 0:
        print("[NOTIFICATION] No new jobs found.")
    else:
        for job in job_list:
            requests.post(
                DISCORD_WEBHOOK,
                json={
                    "embeds": [
                        {
                            "title": f"🎯 New Job Found!",
                            "description": f"**{job['company']}**\n[{job['title']}]({job['link']})",
                        }
                    ]
                },
            )
            time.sleep(0.4)  # To avoid hitting rate limits

        num_jobs = len(job_list)

        if num_jobs == 1:
            print("[NOTIFICATION] Sent 1 new job to Discord.")
        else:
            print(f"[NOTIFICATION] Sent {num_jobs} new jobs to Discord.")
