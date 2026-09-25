import type { SuffixSupport } from "@/lib/support";

export function SuffixPicker({
  items,
  selected,
  exclude,
}: {
  items: SuffixSupport[];
  selected: string[];
  exclude?: string;
}) {
  return (
    <fieldset>
      <legend className="label">Ekstensi yang dipantau</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items
          .filter((i) => i.suffix !== exclude)
          .map((i) => (
            <label
              key={i.suffix}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50"
            >
              <input
                type="checkbox"
                name="suffixes"
                value={i.suffix}
                defaultChecked={selected.includes(i.suffix)}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
              />
              <span className="font-mono">.{i.suffix}</span>
              {!i.supported ? (
                <span className="ml-auto text-[10px] font-medium uppercase text-slate-500" title="Belum ada server RDAP resmi">
                  tidak didukung
                </span>
              ) : null}
            </label>
          ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Ekstensi bertanda &quot;tidak didukung&quot; tetap bisa dipilih, tetapi statusnya akan tampil sebagai Tidak
        didukung sampai registrinya menyediakan RDAP resmi.
      </p>
    </fieldset>
  );
}
