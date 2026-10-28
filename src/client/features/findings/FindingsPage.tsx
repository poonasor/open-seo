import { useQuery } from "@tanstack/react-query";
import { QueryState } from "@/client/components/QueryState";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import { listFindings } from "@/serverFunctions/findings";
import { FindingsBoard } from "./FindingsBoard";

const ALL = "all";

type FindingsFilters = { prefix?: string; site?: string };

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: string[];
  onChange: (value: string | undefined) => void;
}) {
  const items = [
    { value: ALL, label: `All ${label}s` },
    ...options.map((option) => ({ value: option, label: option })),
  ];
  return (
    <Select
      items={items}
      value={value ?? ALL}
      onValueChange={(next) =>
        onChange(next === ALL || next === null ? undefined : next)
      }
    >
      <SelectTrigger size="sm" aria-label={`Filter by ${label}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function FindingsPage({
  projectId,
  filters,
  onFiltersChange,
}: {
  projectId: string;
  filters: FindingsFilters;
  onFiltersChange: (filters: FindingsFilters) => void;
}) {
  const query = useQuery({
    queryKey: ["findings", projectId],
    queryFn: () => listFindings({ data: { projectId } }),
  });

  return (
    <QueryState query={query} errorFallback="Could not load findings.">
      {(all) => {
        const unique = (pick: (f: (typeof all)[number]) => string) => [
          ...new Set(all.map(pick)),
        ];
        const shown = all.filter(
          (f) =>
            (!filters.prefix || f.prefix === filters.prefix) &&
            (!filters.site || f.site === filters.site),
        );
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <FilterSelect
                label="prefix"
                value={filters.prefix}
                options={unique((f) => f.prefix)}
                onChange={(prefix) => onFiltersChange({ ...filters, prefix })}
              />
              <FilterSelect
                label="site"
                value={filters.site}
                options={unique((f) => f.site)}
                onChange={(site) => onFiltersChange({ ...filters, site })}
              />
            </div>
            <FindingsBoard
              projectId={projectId}
              findings={shown}
              hasFilters={all.length > 0}
            />
          </div>
        );
      }}
    </QueryState>
  );
}
