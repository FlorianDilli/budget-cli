import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export type SectionItem<T extends string> = { id: T; label: string };

/**
 * Sub-section state for a screen, stored in the URL query (`?<param>=<id>`).
 * Unknown or missing values fall back to `fallback`. Updates replace the history
 * entry so tab switches do not pollute the back button.
 */
export function useSectionParam<T extends string>(param: string, ids: readonly T[], fallback: T): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(param);
  const value = (ids as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
  const setValue = useCallback((next: T) => {
    setParams((prev) => {
      const copy = new URLSearchParams(prev);
      copy.set(param, next);
      return copy;
    }, { replace: true });
  }, [param, setParams]);
  return [value, setValue];
}

/**
 * The one sub-navigation control for every screen. Render it directly under the page
 * title (or at the start of a page's header row when there is no title).
 * Pair it with `useSectionParam` so the selected section is linkable.
 */
export function SectionTabs<T extends string>({ items, value, onChange, label }: {
  items: readonly SectionItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <nav className="section-tabs" aria-label={label}>
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          className={item.id === value ? 'active' : ''}
          aria-pressed={item.id === value}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
