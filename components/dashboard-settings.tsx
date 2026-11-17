"use client";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DEFAULT_DASHBOARD_SETTINGS, type DashboardSettings } from "@/lib/dashboard-types";

const inputClass = "w-full rounded-lg border border-border bg-[var(--surface-2)] p-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";
export function DashboardSettingsDialog({ settings, onClose }: { settings: DashboardSettings; onClose: () => void }) {
  const [draft, setDraft] = React.useState(settings);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: api.saveDashboardSettings,
    onSuccess: next => {
      qc.setQueryData(["dashboard", "settings"], next);
      onClose();
    },
  });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
      <DialogTitle>Settings</DialogTitle>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(draft); }}>
        <label className="block space-y-1 text-sm"><span>Модель</span><input className={inputClass} value={draft.model} required maxLength={200} onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
        <label className="block space-y-1 text-sm"><span>Уровень рассуждений</span><select className={inputClass} value={draft.reasoningEffort} onChange={event => setDraft({ ...draft, reasoningEffort: event.target.value as DashboardSettings["reasoningEffort"] })}>{["low", "medium", "high", "xhigh"].map(level => <option key={level}>{level}</option>)}</select></label>
        <label className="block space-y-1 text-sm"><span>Промпт</span><textarea className={`${inputClass} min-h-80 resize-y`} value={draft.prompt} required minLength={20} maxLength={16000} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label>
        {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
        <div className="flex justify-between gap-3"><button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={() => setDraft({ ...DEFAULT_DASHBOARD_SETTINGS })}>По умолчанию</button><button type="submit" disabled={save.isPending} className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{save.isPending ? "Сохранение…" : "Сохранить"}</button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
