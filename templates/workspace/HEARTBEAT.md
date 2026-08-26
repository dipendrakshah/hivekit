# Heartbeat

Recurring jobs. The Gateway reads this file. Cron syntax is UTC unless a timezone line is set.

```yaml
timezone: Asia/Kathmandu
jobs:
  - id: morning-news
    every: "0 6 * * *"
    skill: news-site
    prompt: "Refresh the personal news site. Only publish items newer than the last run."
    require_approval: ["git.commit"]
  - id: inbox-sweep
    every: "0 21 * * *"
    skill: file-workshop
    prompt: "Triage inbox/ into out/ with a daily note in memory/."
```

Set `every: "0m"` or delete a block to disable.
