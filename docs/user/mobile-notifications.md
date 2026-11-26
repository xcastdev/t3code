# Mobile notifications

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Live Activity Updates** on iOS, **Agent Live Updates** on Android 16 and newer, or **Ongoing Agent Activity** on older Android versions to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off the same switch to stop future cards.

For activity without ordinary alerts on Android 8 or newer, leave **Ongoing agent activity** enabled and turn off **Agent alerts** in Android's notification settings for T3 Code. Activity updates continue, and the same card shows the finished result without a separate alert. On Android 16 and newer, the finished result remains a Live Update until dismissed or expired. Keep app-wide notification permission and **Live updates** enabled so Android can display it.

On iOS you can also add the **Agent Activity** widget to your Home Screen or Lock Screen. It shows the same agents as the Live Activity, using your T3 Connect sign-in. The widget refreshes when you open T3 and shows unfinished work as out of date after 10 minutes.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. If Live Updates don't appear on Android 16 or newer, check **Live Update Settings** in T3 Code's **Settings → Notifications**. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Background delivery requires T3 Connect; a direct or Tailscale connection alone does not enable push notifications. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## Webhook notifications

Open **Settings → Devices → Notifications** on web or desktop, or **Settings → Notifications** on mobile. Select an environment, add a Home Assistant or generic webhook destination, and enter its URL. Select the events it should receive, enable the destination, and save. You can add several destinations of the same type with different URLs or event filters.

New destinations start disabled. Use **Send test** after saving to check the URL, even while the destination is disabled. Clearing the event selection stops automatic delivery for that destination. Saved URLs and signing keys stay hidden. Enter a new value to replace one.

If a webhook hostname uses split DNS to resolve to a private address, add its exact origin to the server’s `T3CODE_EXTERNAL_NOTIFICATION_PRIVATE_ORIGINS` environment variable and restart the server. For multiple origins, use a comma-separated list such as `https://home.example.com,http://automation.example.com:8123`. Include the scheme and any non-default port. Leave out paths and webhook credentials.

### Receive generic webhook events

Each JSON payload includes a schema version, an event type, a timestamp, an occurrence ID, and the originating environment ID and name. Events include the applicable thread, project, and task IDs. Use the environment ID and occurrence ID together to deduplicate events at the receiver.

Set a signing key on the destination to authenticate requests. Read the raw request body before parsing JSON. Compute HMAC-SHA256 using the signing key and the exact body bytes, then compare the lowercase hexadecimal digest with the value after `sha256=` in the `X-T3-Signature` header. Reject missing or malformed signatures and use a constant-time comparison for valid-length digests.
