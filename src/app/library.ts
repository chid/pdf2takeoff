// Tool library: saved (type + label) presets — the Tool Chest equivalent.
// Activate a preset and every markup you place (or scan hit) carries its
// label, so takeoffs come out grouped without renaming rows. Presets persist
// globally in IndexedDB, not per file.

import { state, emit } from './state';
import { savePresets } from './persistence';
import { setTool, showHint } from './tools';

let listEl: HTMLElement;

export function initLibrary(): void {
  listEl = document.getElementById('presetList')!;
  const input = document.getElementById('presetLabel') as HTMLInputElement;

  document.getElementById('presetSave')?.addEventListener('click', () => {
    const label = input.value.trim();
    if (!label) {
      input.classList.add('invalid');
      setTimeout(() => input.classList.remove('invalid'), 600);
      return;
    }
    if (state.tool === 'pan' || state.tool === 'calibrate' || state.tool === 'scan' || state.tool === 'runs' || state.tool === 'fill' || state.tool === 'viewport') {
      showHint('Pick a measuring tool first (L, A, N, P, O or G), then save it with this label');
      input.classList.add('invalid');
      setTimeout(() => input.classList.remove('invalid'), 600);
      return;
    }
    if (state.presets.some((p) => p.label.toLowerCase() === label.toLowerCase() && p.type === state.tool)) {
      input.classList.add('invalid');
      setTimeout(() => input.classList.remove('invalid'), 600);
      return;
    }
    state.presets.push({ type: state.tool, label });
    void savePresets(state.presets);
    input.value = '';
    renderLibrary();
    emit();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('presetSave')?.click();
  });

  listEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const del = target.closest('[data-del-preset]');
    if (del) {
      const idx = Number(del.getAttribute('data-del-preset'));
      state.presets.splice(idx, 1);
      if (state.activePreset && state.presets.length === 0) state.activePreset = null;
      void savePresets(state.presets);
      renderLibrary();
      emit();
      return;
    }
    const chip = target.closest('[data-preset]');
    if (chip) activatePreset(Number(chip.getAttribute('data-preset')));
  });

  renderLibrary();
}

/** Activate a preset: switch to its tool and label everything placed next. */
export function activatePreset(index: number): void {
  const preset = state.presets[index];
  if (!preset) return;
  state.activePreset = preset;
  setTool(preset.type);
  state.activePreset = preset; // setTool keeps matching types, restore anyway
  showHint(`${preset.label} · click to place; pick another tool to stop`);
  renderLibrary();
  emit();
}

export function renderLibrary(): void {
  if (!listEl) return;
  listEl.replaceChildren();
  if (state.presets.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'preset-empty';
    empty.textContent = 'Save a tool + label once (e.g. Length “Skirting”); click it later to measure pre-labelled.';
    listEl.appendChild(empty);
    return;
  }
  state.presets.forEach((p, i) => {
    const chip = document.createElement('button');
    chip.className = 'preset-chip' + (state.activePreset === p ? ' active' : '');
    chip.dataset.preset = String(i);
    const icon = p.type === 'length' ? '📏' : p.type === 'area' ? '⬡' : p.type === 'count' ? '🔢' : p.type === 'perimeter' ? '↻' : p.type === 'volume' ? '◨' : '∠';
    chip.innerHTML = `<span class="tag tag-${p.type}">${icon} ${p.type}</span><span class="preset-label">${escapeHtml(p.label)}</span><span class="preset-del" data-del-preset="${i}" title="Delete preset">✕</span>`;
    chip.title = `Measure ${p.type} pre-labelled “${p.label}”`;
    listEl.appendChild(chip);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
