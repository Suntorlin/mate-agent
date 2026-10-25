# Demo Studio design system

How the web app looks and behaves, and the components it is built from. Read this before adding or
restyling UI. `--social-*` is the palette's name; the components are this app's own, in plain CSS.

Live preview of every component, light and dark: `npm run dev:web -w @open-inspect/demo-app`, then
open `/design.html` (`?theme=dark` for dark).

## Principles

**Visual: monochrome zinc, pills and large radii, whitespace over borders, flat. Behaviour: Apple
HIG.**

1. **One primary action per view.** One filled (black or white) button; the rest are secondary,
   outline or ghost. In the chat that is Send; on the empty state it is New conversation.
2. **44px on phones.** Every tappable target has a hit area of at least 44px. `IconButton` is 44;
   `sm` (36) is for dense desktop toolbars. `Chip` pads its hit area; rows grow to 44 on phones.
3. **Inputs are 16px.** Smaller text makes iOS Safari zoom the page on focus.
4. **Tokens only.** No colour literal, no font size, weight, radius, shadow or duration outside
   `web/design/tokens.css`. Need something new: add a token first.
5. **Prefer less.** A label, hint or divider that adds no information is deleted.
6. **Dark mode is not optional.** Check every screen light and dark, on a phone (390px) and a
   desktop (1200px).
7. **Restyling never changes logic.** Behaviour, API calls and copy stay as they are.

## Tokens (`web/design/tokens.css`)

`:root` is light, `[data-theme="dark"]` is dark. Components read `var(--token)`.

| Group  | Tokens                                                                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colour | `--social-surface muted hover border divider fg fg-muted fg-subtle primary primary-fg badge danger success warning on-accent bar-bg`                                                                     |
| Tint   | `--badge-{info,success,warning,error}-{bg,text}` (soft fill and text of a state)                                                                                                                         |
| Canvas | `--canvas-page`: pages the agent made are drawn on white in both themes                                                                                                                                  |
| Shadow | `--shadow-raised card float sheet`, `--scrim`: flat by default, only floating things get one                                                                                                             |
| Radius | `--radius-pill` (buttons, chips, badges), `-card` 16, `-field` 12 (inputs, rows), `-tag` 8 (inline code, tiny tags)                                                                                      |
| Type   | `--text-{caption 12, small 13, body 15, title 16, heading 20, display 32}` with `--leading-*`; weights 400 and 600 only                                                                                  |
| Size   | `--touch-min 44`, `--control-{sm 36, md 44, lg 48}`, `--chip-height 32`, `--badge-height 24`                                                                                                             |
| Shell  | `--safe-top`, `--safe-bottom`, `--tab-bar-height`, `--page-header-height`, `--nav-rail-width`, `--list-column-width`, `--content-max-width`; `--orb-{0..5}-{0,1,2}` avatar orbs, the same in both themes |
| Motion | `--motion-fast 150ms`, `--motion-base 200ms`, `--motion-ease`; no decorative animation (shimmer marks live work)                                                                                         |

Theme: `web/design/theme.ts` (`useTheme`) stores `light`, `dark` or system in localStorage and sets
`data-theme` on `<html>`; `web/index.html` applies it before first paint.

## Components (`web/ui/`)

Pages compose these; they do not hand-write `<button>`, `<input>`, `<textarea>` or `<select>`. Each
component is a `.tsx` and a `.css` with its own `ui-` class prefix, exported from `ui/index.ts`.

| Component               | Use                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Button`                | `variant` default / secondary / outline / ghost / destructive; `size` sm / default / lg; `href` makes a link         |
| `IconButton`            | Icon-only; `label` is required (aria and tooltip); `variant` ghost / muted / filled; `size` default / sm             |
| `TextField`, `TextArea` | 44px, 16px text; `variant` field / pill; `invalid`. `TextArea` grows and has no chrome: put it in a card             |
| `FormField`             | Caption above a control, hint or error below                                                                         |
| `Chip`, `StaticChip`    | 32px pill: a filter, a choice or a shortcut; selected is filled                                                      |
| `Badge`                 | A state (`default solid info success warning destructive`), never an action; optional `icon`                         |
| `ListGroup`, `ListRow`  | iOS-style grouped list; `compact` rows for a sidebar; `onClick` makes a row a button                                 |
| `Tabs`                  | Pill tabs that scroll sideways                                                                                       |
| `Notice`                | A short message in a pill; `danger` is announced as an alert                                                         |
| `Shimmer`               | Text that glints while work is in progress                                                                           |
| `Sheet`                 | A panel over the page (bottom or left) with a scrim; Escape closes it. Phones use it for the sidebar and the preview |
| `icons.tsx`             | The line icons (20px grid, current colour)                                                                           |

## The app shell

`web/AppShell.tsx` is the signed-in app: on a **phone** every page is a screen and a `TabBar`
switches the top-level ones (Chats, Me); a chat is a screen of its own with a back button and no tab
bar, and the preview is a bottom `Sheet`. On a **desktop** (768px and wider) a `NavRail`, the chat
list, the chat and its preview sit side by side. Where the app is lives in the URL hash (`#/chats`,
`#/chats/<id>`, `#/me`; `web/route.ts`), so back and reload work.

| Screen            | File                       |
| ----------------- | -------------------------- |
| Chat list         | `ChatsList.tsx`            |
| One conversation  | `ChatPane.tsx`, `Chat.tsx` |
| Preview           | `Preview.tsx`              |
| Account and theme | `MePage.tsx`               |
| Sign in           | `AuthScreen.tsx`           |

## Do and don't

| Do                                     | Don't                                |
| -------------------------------------- | ------------------------------------ |
| `<Button>`, `<IconButton label="...">` | `<button className="...">` in a page |
| `color: var(--social-fg-muted)`        | `color: #71717a`, `color: gray`      |
| `border-radius: var(--radius-card)`    | `border-radius: 10px`                |
| `font-weight: var(--weight-strong)`    | `font-weight: 500`, `bold`           |
| `Badge` for a state                    | A tinted box drawn by hand           |
| One filled button per view             | Two competing primary buttons        |

## Enforced

`web/design/design-rules.test.ts` runs with `npm test -w @open-inspect/demo-app` and in
`npm run verify`. It fails on: a colour literal outside `tokens.css`; a font size, weight, radius,
shadow or duration that is not a token; a raw `<button>`, `<input>`, `<textarea>` or `<select>`
outside `ui/`; an `IconButton` without `label`; a component in `ui/index.ts` that the showcase does
not show.

The browser end-to-end check (`npm run e2e:ui`, `docs/LOCAL_E2E.md`) holds the rest: reload and
back, themes, resizing, 44px targets on a phone, control names, unsafe text, the preview's
isolation.

## Checklist for a UI change

1. Components and tokens only (the test checks this).
2. Phone and desktop, light and dark, screenshotted and looked at.
3. Touch targets at least 44px on a phone; inputs 16px.
4. New component: its `.tsx`, `.css`, an export in `ui/index.ts`, an entry in
   `web/design/Showcase.tsx` and a row in the table above, in the same change.
5. `npm run verify` passes, and `npm run e2e:ui` for a change that moves layout or behaviour.

## Where things live

| What                | Where                                                |
| ------------------- | ---------------------------------------------------- |
| Tokens, base, theme | `web/design/` (`tokens.css`, `base.css`, `theme.ts`) |
| Components          | `web/ui/`                                            |
| Showcase            | `web/design.html`, `web/design/Showcase.tsx`         |
| Product screens     | `web/*.tsx` with a `.css` beside each                |
| Rules as tests      | `web/design/design-rules.test.ts`                    |
