# External notifications

External notifications send agent awareness updates from a T3 Code environment to Home Assistant. Home Assistant delivers the push. T3 Connect Cloud does not.

## Add a Home Assistant destination

1. Open **Settings → Integrations**.
2. Select the environment that owns the notification settings.
3. Under **External notifications**, click **Add Home Assistant destination**.
4. Give the destination a label.
5. Paste the Home Assistant webhook URL and click **Replace URL**.
6. Turn on the destination.
7. Click **Send test**.

Home Assistant creates webhook URLs under **Settings → Automations & scenes → Webhooks**. A webhook automation can use a URL such as:

```text
https://home.example.com/api/webhook/your-webhook-id
```

T3 Code stores the URL as a server secret and redacts it from settings sent to connected clients. The URL is never shown after you save it. To replace it, paste the new URL and click **Replace URL**. To remove it, remove the destination.

## Notification payload

The Home Assistant webhook receives JSON like this:

```json
{
  "schemaVersion": 1,
  "test": false,
  "environmentId": "environment-id",
  "threadId": "thread-id",
  "state": {
    "environmentId": "environment-id",
    "threadId": "thread-id",
    "phase": "running",
    "projectTitle": "Website",
    "threadTitle": "Fix the login form",
    "modelTitle": "Claude",
    "headline": "Running",
    "detail": "Editing the form",
    "updatedAt": "2026-08-31T00:00:00.000Z",
    "deepLink": "/threads/environment-id/thread-id"
  },
  "projectTitle": "Website",
  "threadTitle": "Fix the login form",
  "modelTitle": "Claude",
  "phase": "running",
  "headline": "Running",
  "detail": "Editing the form",
  "relativeRoute": "/threads/environment-id/thread-id",
  "deepLink": "t3code-dev://threads/environment-id/thread-id"
}
```

The `state` field is `null` when the thread or project is no longer available. The top-level state fields are omitted in that case. Test notifications set `test` to `true` and use a synthetic thread ID.

## Choose an app link scheme

The default scheme is `t3code-dev`. Choose the scheme that matches the app you use:

- `t3code-dev` for development builds
- `t3code-preview` for preview builds
- `t3code` for production builds

The selected scheme produces links in this form:

```text
t3code-preview://threads/<encoded-environment-id>/<encoded-thread-id>
```

The environment ID and thread ID are encoded separately. The relative route is also included for automations that open T3 Code in a browser.

## Build note for iOS

Free iOS Personal Team builds expire after 7 days. When that happens, reinstall the app before opening notification deep links from Home Assistant.
