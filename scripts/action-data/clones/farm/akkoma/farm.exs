# Clone-farm overrides (appended to the generated config.exs): plain http on social.farm.test,
# no federation, no rate limits or captcha, so seeding and scripted episodes run freely.
config :pleroma, Pleroma.Web.Endpoint,
  url: [host: "social.farm.test", scheme: "http", port: 80],
  secure_cookie_flag: false
config :pleroma, :instance,
  federating: false,
  allow_relay: false,
  registrations_open: false,
  account_activation_required: false,
  account_approval_required: false,
  healthcheck: true,
  limit: 5000,
  public: true
config :pleroma, :rate_limit, nil
config :pleroma, Pleroma.Captcha, enabled: false
config :pleroma, :frontend_configurations, pleroma_fe: %{showInstanceSpecificPanel: false, hideSitename: false, redirectRootNoLogin: "/main/all", collapseMessageWithSubject: false}
config :pleroma, :frontends, primary: %{"name" => "pleroma-fe", "ref" => "stable"}, admin: %{"name" => "admin-fe", "ref" => "stable"}
config :pleroma, Oban, queues: [federator_incoming: 5, federator_outgoing: 5, web_push: 2, mailer: 2, transmogrifier: 5, scheduled_activities: 2, background: 5, slow: 2, search_indexing: 2]
config :pleroma, :http_security, enabled: false
config :pleroma, :welcome, direct_message: [enabled: false]
config :logger, level: :warning
config :pleroma, :frontends, primary: %{"name" => "pleroma-fe", "ref" => "stable"}, admin: %{"name" => "admin-fe", "ref" => "stable"}, mastodon: %{"name" => "mastodon-fe", "ref" => "akkoma"}
