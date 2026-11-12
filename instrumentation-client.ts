import posthog from "posthog-js";

// The same PostHog project and proxy as openui.com; lib/analytics.ts sends the server's events there.
if (!["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) {
  posthog.init("phc_3OLW53x09ZTVZSV6BEpj5uycj3ooqR6KOemOjx04e3D", {
    api_host: "https://dgoeivjus9jfp.cloudfront.net",
    capture_pageview: "history_change",
    disable_surveys: true,
  });
  posthog.register({ app: "opendashboards" });
}
