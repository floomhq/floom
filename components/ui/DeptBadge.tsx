type Department = "sales" | "cs" | "marketing" | "finance" | "product" | "other";

const styles: Record<Department, { bg: string; text: string; label: string }> = {
  sales: { bg: "bg-blue-50", text: "text-blue-700", label: "Sales" },
  cs: { bg: "bg-green-50", text: "text-green-700", label: "CS" },
  marketing: { bg: "bg-yellow-50", text: "text-yellow-800", label: "Marketing" },
  finance: { bg: "bg-purple-50", text: "text-purple-700", label: "Finance" },
  product: { bg: "bg-sky-50", text: "text-sky-700", label: "Product" },
  other: { bg: "bg-gray-50", text: "text-gray-600", label: "Other" },
};

export function DeptBadge({ department }: { department: Department }) {
  const s = styles[department] ?? styles.other;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${s.bg} ${s.text}`}
    >
      {s.label}
    </span>
  );
}
