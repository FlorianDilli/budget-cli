// Hosts the standalone moonli Budget page (public/budget/index.html) unchanged.
export function BudgetPage() {
  return (
    <iframe
      className="budget-frame"
      src={`${import.meta.env.BASE_URL}budget/index.html`}
      title="moonli Budget"
    />
  );
}
