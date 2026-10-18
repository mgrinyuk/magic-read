/* PostHog product analytics — website only.
 *
 * The native apps skip it: they share this frontend, but analytics there would
 * have to be declared in the App Store and Play privacy labels, and nothing has
 * been declared. window.Capacitor exists in both shells before any page script.
 *
 * Privacy choices, deliberately strict:
 *   - persistence "memory": no cookies, no localStorage, so no consent banner.
 *     A logged-out visitor is a stranger on every page load.
 *   - person_profiles "identified_only": a person exists only once app.js calls
 *     identify() with the internal account id after login — never an email or
 *     name. That is what lets retention ("came back the next day") work.
 *   - mask_all_text: autocapture records that something was clicked, not its
 *     text. Readers tap words in texts people paste in themselves.
 *   - no session recording.
 * EU Cloud: the project lives in Frankfurt; the US host rejects its key.
 */
(function () {
  if (window.Capacitor) return;

  !function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  window.posthog.init("phc_tNonDHKNvYWyJaGvwzUrTC68MsXDuPHLJ7xmWDgj6qgM", {
    api_host: "https://eu.i.posthog.com",
    ui_host: "https://eu.posthog.com",
    persistence: "memory",
    person_profiles: "identified_only",
    capture_pageview: "history_change",
    disable_session_recording: true,
    mask_all_text: true
  });
})();
