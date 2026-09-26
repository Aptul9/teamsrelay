// Everything the agent knows about Teams web: hosts, selectors and the English texts it reads. When Microsoft
// changes the interface, the change goes here (docs/teams-selectors.md lists the same items).

// Teams web moved from teams.microsoft.com to teams.cloud.microsoft; teams.live.com is Teams for personal accounts
export const TEAMS_HOSTS = ["teams.microsoft.com", "teams.cloud.microsoft", "teams.live.com"];
export const LOGIN_HOSTS = ["login.microsoftonline.com", "login.live.com", "login.microsoft.com"];
// Outside Edge, Defender for Cloud Apps (Conditional Access App Control) proxies the session and appends its
// suffix to every host: teams.cloud.microsoft.mcas.ms
export const PROXY_SUFFIX = /\.mcas(-gov)?\.(ms|us)$/;

export const TEXTS = {
  // the chat with yourself is listed as "Name (You)"
  selfChat: "(You)",
  // preview of a chat whose last message is yours
  outbound: /^(you|tu):/i,
  // "Read by X of Y" entry of the message menu, in group chats
  readBy: /^Read by (\d+) of (\d+)/,
  // notifications Teams shows about itself, not about a message
  ownNotification: /^(Nice job|Notifications are now on)/i,
  // title the notification hook gets from the health probe of earlier releases
  healthTag: "__HEALTHCHECK__",
};
