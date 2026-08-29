import { useMemo } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { short, statusTone, type UiApproval } from "@/types";
import { StatusBadge } from "./message-bubble";
import type { SnapshotJob } from "@hivekit/protocol";

const col = createColumnHelper<SnapshotJob>();

function JobsTable({ jobs }: { jobs: SnapshotJob[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo(
    () => [
      col.accessor("status", {
        header: "Status",
        cell: (info) => <StatusBadge status={info.getValue()} />,
      }),
      col.accessor("title", {
        header: "Job",
        cell: (info) => <span className="block max-w-[320px] truncate" title={info.getValue()}>{info.getValue()}</span>,
      }),
      col.accessor("usd", {
        header: "Spend",
        cell: (info) => <span className="font-mono text-[11px]">${info.getValue().toFixed(4)}</span>,
      }),
      col.accessor((row) => (row.master_model ? `M ${short(row.master_model)}` : ""), {
        id: "models",
        header: "Models",
        cell: (info) => <span className="font-mono text-[11px] text-muted-foreground">{info.getValue()}</span>,
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: jobs,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="overflow-hidden rounded-xl border">
      <table className="w-full text-sm">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="bg-muted/50 border-b">
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  onClick={h.column.getToggleSortingHandler()}
                  className="cursor-pointer px-3 py-2 text-left font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase select-none"
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: " ▲", desc: " ▼" }[h.column.getIsSorted() as string] ?? ""}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-3 py-2">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReceiptsView({ approvals, jobs }: { approvals: UiApproval[]; jobs: SnapshotJob[] }) {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 md:p-6">
      <div>
        <h2 className="text-base font-semibold">Receipts</h2>
        <p className="font-mono text-[11px] text-muted-foreground">every irreversible action, who decided, when</p>
      </div>

      {approvals.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No approvals observed this session. Historical receipts render from the ledger once the receipts endpoint lands.
        </p>
      )}
      {approvals.map((a) => (
        <Card key={a.id} className="gap-3 py-4">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm">{a.title}</CardTitle>
              <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${statusTone(a.decided ?? "pending")}`}>
                {a.decided ?? "pending"}
              </span>
            </div>
            <span className="font-mono text-[11px] text-muted-foreground">{a.requires_receipt_for}</span>
          </CardHeader>
          {a.diff_preview && (
            <CardContent>
              <pre tabIndex={0} className="max-h-56 overflow-auto rounded-lg border bg-[#14120e] p-2.5 font-mono text-[11.5px] whitespace-pre">
                {a.diff_preview}
              </pre>
            </CardContent>
          )}
        </Card>
      ))}

      <h2 className="pt-2 text-base font-semibold">Jobs</h2>
      {jobs.length === 0 ? <p className="text-sm text-muted-foreground">none yet</p> : <JobsTable jobs={jobs} />}
    </div>
  );
}
