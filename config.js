// Blueprint-ify settings for a hosted copy.
//
// Leave api empty and every visitor draws with their own Anthropic API key, which they
// paste into the page and which stays in their browser.
//
// Or set api to the address of your proxy (see the proxy section of README.md) and visitors draw on
// your account without a key of their own:
//
//   window.BLUEPRINTIFY = { api: "https://blueprintify-proxy.yourname.workers.dev" };
//
// models is optional and maps the page's three tiers to Claude model IDs.
window.BLUEPRINTIFY = {
  api: "",
  models: { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5" },
};
