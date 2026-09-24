# Selettori di Teams

Tutto quello che l'agent sa di Teams web sta in `agent/agent.py`. Se Microsoft cambia l'interfaccia, si interviene qui. Verificati su Teams web in inglese (`teams.cloud.microsoft`) a settembre 2026.

## Pagina e lista chat

| Elemento | Selettore |
|---|---|
| Scheda di Teams | URL con `teams.cloud.microsoft` (o il vecchio `teams.microsoft.com`) |
| Sezioni della lista | `[role="treeitem"][aria-level="1"]`: *Quick views*, *Favorites*, *Chats*; `aria-expanded` dice se sono aperte |
| Chat | `[role="treeitem"][aria-level="2"]` sotto *Chats* o *Favorites* |
| Non letta | `[data-tid="unread"]` nella riga |
| Silenziata | riga con `data-item-type="muted-chat"`, icona `[data-testid="muted-icon"]` |
| Foto | `img.fui-Avatar__image` |
| Chat aperta | `[data-tid="chat-title"]` |
| Vista Attività / Chat | pulsanti della barra laterale con `aria-label` che inizia per `Activity` / `Chat` |

## Messaggi

| Elemento | Selettore |
|---|---|
| Contenitore | `[data-tid="chat-pane-item"]`, un messaggio per contenitore |
| Messaggio | `[data-tid="chat-pane-message"]` con `data-mid`; i tuoi sono dentro `.fui-ChatMyMessage` |
| Corpo | `#content-<mid>` o `[data-tid="messageBodyContent"]` |
| Autore e foto | `[data-tid="message-author-name"]`, `[data-tid="message-avatar"]` nel contenitore, solo sul primo di una serie |
| Menzione | `[itemtype*="Mention"]` dentro `[data-mention-type]`; `aria-label="Mentioned you"` se sei tu |
| Emoji | `img` con `itemtype` Emoji o dentro `[data-tid="emoticon-renderer"]`, l'emoji è nell'`alt` |
| Immagini | `itemtype` AMSImage, `data-tid="lazy-image-*"` |
| Allegati | `[data-tid="file-attachment-grid"]`, nome e URL nell'`aria-label` |
| Citazione | `[data-tid="quoted-reply-card"]`, `[data-tid="quoted-reply-preview-content"]` |
| Reazioni | `[data-tid="diverse-reaction-pill-button"]`, `aria-pressed="true"` se è tua |
| Stato | `[class*="fui-ChatMyMessage__statusIcon"]`, `aria-label` `Sent`, `Seen`, `Seen by everyone` |
| Modificato | span con testo `Edited` nell'intestazione |
| Eliminato | `[data-tid="message-tombstone"]`, `[data-tid="message-undo-delete-btn"]` |

## Azioni

| Azione | Selettore |
|---|---|
| Barra azioni | `[data-tid="message-actions-container"]`, in un portal |
| Reazioni rapide | `message-actions-like`, `-heart`, `-laugh`, `-surprised` |
| Altre reazioni | `expanded-reactions-picker-entry`, poi `emoticon-button-cry`, `emoticon-button-angry` |
| Modifica | `message-actions-edit`; conferma `newMessageCommands-send`; annulla `newMessageCommands-discard-draft` e `messagedraft-discard-confirm` |
| Menu | `message-actions-more`, voci `[role="menuitem"]` |
| Rispondi | `message-actions-quoted-reply`; citazione nel box con `close-quoted-reply` |
| Elimina | `message-actions-delete` nel menu |
| Letto da | `message-actions-read-receipt` nel menu, nomi nel sottomenu |
| Editor e invio | `[data-tid="ckeditor"]`; invio `sendMessageCommands-send` o `newMessageCommands-send` a seconda del layout |

## Attività

| Elemento | Selettore |
|---|---|
| Voce | `[data-tid="activity-feed-list-item"]`, id in `aria-labelledby` |
| Titolo | `[data-tid="activity-feed-item-title"]` |
| Righe | anteprima, orario, luogo; l'orario è riconosciuto dal formato |

## Sessione scaduta

Testi `REDUCED_CAPABILITIES`, *Chats are temporarily unavailable*, *Sync engine is running in Reduced*, *We need you to sign in again*.
