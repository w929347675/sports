import type { ChangeEvent } from 'react';

export const statusLabels = {
  training: '训练日',
  rest: '休息日',
  paused_sick: '暂停 / 生病',
  travel: '旅行',
  custom: '自定义',
} as const;

export function StatusSelect({ value, onChange }: { value: keyof typeof statusLabels; onChange: (value: keyof typeof statusLabels) => void }) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value as keyof typeof statusLabels);
  return (
    <label>
      当天状态
      <select value={value} onChange={handleChange}>
        {Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </label>
  );
}
