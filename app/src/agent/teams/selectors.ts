import type { ReactionName } from "@/shared/slot-db/commands";

// Everything the agent knows about Teams web: hosts, selectors and the English texts it reads. When Microsoft
// changes the interface, the change goes here; docs/teams-selectors.md lists the same items. Page scripts get
// SEL and TEXTS as argument, Node-side locators use them directly.

// Teams web moved from teams.microsoft.com to teams.cloud.microsoft; teams.live.com is Teams for personal accounts
export const TEAMS_HOSTS = ["teams.microsoft.com", "teams.cloud.microsoft", "teams.live.com"];
export const LOGIN_HOSTS = ["login.microsoftonline.com", "login.live.com", "login.microsoft.com"];
// Outside Edge, Defender for Cloud Apps (Conditional Access App Control) proxies the session and appends its
// suffix to every host: teams.cloud.microsoft.mcas.ms
export const PROXY_SUFFIX = /\.mcas(-gov)?\.(ms|us)$/;

export const SEL = {
  // chat list: sections (Quick views, Favorites, Chats) at level 1, chats at level 2 under them
  section: '[role="treeitem"][aria-level="1"]',
  collapsedSection: '[role="treeitem"][aria-level="1"][aria-expanded="false"]',
  sectionHeader: ':scope > :not([role="group"])',
  chatRow: '[role="treeitem"][aria-level="2"][id^="menu"]',
  anyChatRow: '[role="treeitem"][aria-level="2"]',
  listItem: '[role="treeitem"][id^="menu"]',
  unread: '[data-tid="unread"]',
  mention: '[data-tid*="mention" i],[class*="mention" i]',
  mutedIcon: '[data-testid="muted-icon"]',
  mutedItemType: "muted-chat",
  avatar: "img.fui-Avatar__image",
  chatTitle: '[data-tid="chat-title"]',

  // side bar and header
  activityView: 'button[aria-label^="Activity"]',
  chatView: 'button[aria-label^="Chat"]',
  presence: '[data-tid="me-control-avatar-presence"]',
  meAvatar: '[data-tid="me-control-avatar"] img',
  editor: '[data-tid="ckeditor"]',
  textbox: '[role="textbox"]',

  // conversation
  item: '[data-tid="chat-pane-item"]',
  message: '[data-tid="chat-pane-message"]',
  mine: ".fui-ChatMyMessage",
  body: '[id^="content-"]',
  bodyAlt: '[data-tid="messageBodyContent"]',
  author: '[data-tid="message-author-name"]',
  messageAvatar: '[data-tid="message-avatar"] img.fui-Avatar__image, [data-tid="message-avatar"] img',
  quote: '[data-tid="quoted-reply-card"]',
  quotePreview: '[data-tid="quoted-reply-preview-content"]',
  files: '[data-tid="file-attachment-grid"]',
  pill: '[data-tid="diverse-reaction-pill-button"]',
  emoticon: '[data-tid="emoticon-renderer"]',
  statusIcon: '[class*="statusIcon"]',
  tombstone: '[data-tid="message-tombstone"]',
  undoDelete: '[data-tid="message-undo-delete-btn"]',
  mentionBox: "[data-mention-type]",
  fileEntry: '[aria-label*="https://"]',
  anyAvatar: '[data-tid*="avatar" i]',
  // itemtype of emoji images, mentions and message images; data-tid of lazily loaded images
  emojiType: /Emoji/i,
  mentionType: /Mention/i,
  imageType: /AMSImage/i,
  lazyImage: /^lazy-image/,
  // a message image shows a 1x1 placeholder until Teams has loaded it; its address is in this attribute
  lazyImageSource: "data-orig-src",
  // parts of a message body left out of its text: quote, attachments, reactions, action bar
  bodySkip: '[data-tid="quoted-reply-card"],[data-tid="file-attachment-grid"],[data-tid*="reaction"],[data-tid^="message-actions"]',

  // action bar, drawn in a portal outside the message
  actionBar: '[data-tid="message-actions-container"]',
  menu: '[role="menu"]',
  menuItem: '[role="menuitem"]',
  overlays: '[role="menu"],[role="dialog"],[role="alertdialog"]',
  sendButton: '[data-tid="sendMessageCommands-send"]',
  // members of a group chat: the participant count in the header opens a list of them. Every row also holds a
  // remove button: nothing inside the list is ever clicked.
  participantCount: '[data-tid="chat-header-participant-count"]',
  rosterName: '[id^="chat-roster-item-name-"]',
  // members named in the header of 1:1 chats and of group chats without a name
  topicParticipant: '[data-tid="chat-topic-menu"] [id^="chat-topic-person-"]',
  // @ typed in the compose box opens this list of people; data-tid of an entry is the prefix and the person's
  // name. The person picked becomes a mention element in the box.
  mentionPopup: '[data-tid="AutocompletePopup-Mentions"]',
  mentionOptionPrefix: "autocomplete-picker-item-",
  composerMention: '[itemtype*="Mention"]',
  editDone: '[data-tid="newMessageCommands-send"]',
  editDiscard: '[data-tid="newMessageCommands-discard-draft"]',
  discardConfirm: '[data-tid="messagedraft-discard-confirm"]',
  closeQuote: '[data-tid="close-quoted-reply"]',

  // incoming call: a toast of its own in the page, never a browser notification while the page is visible, with the
  // buttons to answer and decline (never clicked); its text names the caller
  callToast: '[data-testid="calling-notification"]',
  callText: '[id^="cn-calling-main-content-"]',
  // clicked only to answer from the app, only this button of the toast
  callAccept: '[data-testid="calling-notification"] [data-testid="calling-actions"] button[aria-label="Accept with audio"]',
  // the microphone button of the call in progress, full screen and in the floating call monitor alike; Teams can leave
  // a hidden one in the page after the call. Its state shows twice: data-state (callMicMuted, callMicLive) and the
  // action a click takes, data-track-action-scenario (callMicUnmute while muted, callMicMute while live). Seen on slot 2
  // on 2026-09-29: live "mic-volume-renderer" and "callMuteAudio", muted "mic-off" and "callUnmuteAudio"; "mic" is the
  // live state of other builds. Clicked only to mute from the app where its shortcut changed nothing.
  callMic: "#microphone-button",
  callMicMuted: ["mic-off"],
  callMicLive: ["mic", "mic-volume-renderer"],
  callMicUnmute: "callUnmuteAudio",
  callMicMute: "callMuteAudio",

  // Activity feed: the id of an item is in the id of its title, named by aria-labelledby
  feedItem: '[data-tid="activity-feed-list-item"]',
  feedTitle: '[data-tid="activity-feed-item-title"]',
  feedItemId: /activity-feed-item-title-(\d+)/,

  // Teams keeps the signed-in profile in localStorage
  userKey: "tmp.auth.v1.GLOBAL.User.User",
  tenantsKey: /^tmp\.auth\.v1\..*\.Tenants\.Tenants$/,
};
export type Selectors = typeof SEL;

// data-tid of the buttons of the action bar and of the message menu
export const ACTIONS = {
  more: "message-actions-more",
  edit: "message-actions-edit",
  quotedReply: "message-actions-quoted-reply",
  delete: "message-actions-delete",
  readReceipt: "message-actions-read-receipt",
  picker: "expanded-reactions-picker-entry",
};

// Reactions of the web app: four on the bar, two in the picker
export const BAR_REACTIONS: Partial<Record<ReactionName, string>> = {
  like: "message-actions-like",
  heart: "message-actions-heart",
  laugh: "message-actions-laugh",
  surprised: "message-actions-surprised",
};
export const PICKER_REACTIONS: Partial<Record<ReactionName, string>> = { cry: "emoticon-button-cry", angry: "emoticon-button-angry" };

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

  // chat list
  listSection: /^(Chats|Chat|Favorites|Preferiti)\b/i,
  listNoise: /^(Copilot|Drafts|Quick views.*|Favorites|Chats|Meet now|Activity|Unread)$/i,
  listPrefix: /^(Favorites|Chats|Quick views|Recent|Drafts)\s+/i,
  statusWords: /\b(Unread|Offline|Away|Available|Busy|Do not disturb|Be right back|Presence unknown|Out of office)\b/gi,
  listTime: /\d{1,2}:\d{2}\s?(AM|PM)?|\d{1,2}\/\d{1,2}/,
  listNameEnd: /\s+\d{1,2}:\d{2}|\s+\d{1,2}\/\d{1,2}|\s+You:/,
  mentionLabel: /mention|menzion/i,

  // conversation: aria-label of a message starts with its author ("Anna Rossi, ...")
  authorLabel: /^([^,]+),/,
  edited: /^(Edited|Modificato)$/i,
  mentionedYou: "Mentioned you",
  // status of your message until Teams has it, then "Sent"; Teams draws it under the last message of yours only
  sending: /^Sending/i,
  // status of a message Teams could not send
  sendFailed: /fail/i,

  // incoming call toast: "Anna Rossi is calling you", with "External" before the name of a person of another
  // organization
  callingYou: /^(.+?)\s+is (?:video )?calling you\b/i,
  externalMark: /^External\s+/i,

  // session expired or Teams syncing in reduced mode
  sessionLost:
    /REDUCED_CAPABILITIES|Chats are temporarily unavailable|Sync engine is running in Reduced|We need you to sign in again|Chat non (?:sono )?disponibili/i,

  // Activity feed: the time line is recognized by its format; before it the preview, after it the place
  feedTime: /^(\d{1,2}:\d{2}\s?(AM|PM)?|\d{1,2}\/\d{1,2}(\/\d{2,4})?|Yesterday|Ieri|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i,
  missedCall: /^Missed call from (.+)$/i,
  // the person comes before the action ("Anna Rossi assigned you a task")
  feedAction:
    /\s+(reacted|mentioned|replied|liked|sent|posted|invited|scheduled|assigned|updated|added|removed|shared|commented|canceled|cancelled|accepted|declined|started|joined|changed|created|edited|forwarded)\b.*$/i,
  feedReaction: /reacted/i,
  feedMention: /mentioned/i,
  feedReply: /repl/i,
  feedTask: /assigned you a task/i,
  feedTeam: /added you to/i,
  inChatWithYou: /^In chat with you$/i,
  meetingTime: /\d{1,2}:\d{2}\s?(AM|PM)?\s*-\s*\d{1,2}:\d{2}/i,
};
export type Texts = typeof TEXTS;
