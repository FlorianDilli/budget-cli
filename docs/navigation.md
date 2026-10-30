# Sub-navigation convention

Every screen with more than one section uses the same control and state handling.

## Rules

1. **Control.** Use `SectionTabs` from `web/src/ui/SectionTabs.tsx`. Do not build a tab bar per screen, and do not add new tab styles. The only styles are the `.section-tabs` block in `web/src/styles.css`.
2. **Placement.** Render it directly under the page title, left-aligned. On screens without a title (for example, the Budget studio header), place it at the start of the header row.
3. **State.** Store the selected section in the URL query with `useSectionParam(param, ids, fallback)`. Use one param per screen: `tab` for section switches (Settings), `view` for layout views (Budget). This makes sections linkable and survives reloads.
4. **One level.** Sub-sections never nest. A screen that needs deeper structure should become separate top-level routes.
5. **Modes are sections.** Layout choices such as Editor / Split / Visual Budget use the same control. Do not add separate toggles.
6. **Mobile.** The control scrolls horizontally when it overflows. Hide an item only when its view cannot work at that width, and say so in the screen's code.

## Example

```tsx
const TABS = ['editor', 'data'] as const;
type Tab = (typeof TABS)[number];
const TAB_ITEMS = [
  { id: 'editor', label: 'Editor' },
  { id: 'data', label: 'Data' },
] as const satisfies readonly SectionItem<Tab>[];

const [tab, setTab] = useSectionParam<Tab>('tab', TABS, 'editor');
<SectionTabs items={TAB_ITEMS} value={tab} onChange={setTab} label="Settings sections" />
```
