export function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="mb-8">
      <h1 className="text-[1.75rem] leading-tight font-bold tracking-tight">{title}</h1>
      <p className="mt-2 max-w-xl text-[0.9375rem] text-muted-foreground">{description}</p>
    </header>
  );
}

export function SectionLabel({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="mb-3 text-sm font-semibold">
      {children}
    </h2>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl bg-neutral-100/80 px-6 py-8 text-center">
      <Icon className="mb-3 size-6 text-muted-foreground" />
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
