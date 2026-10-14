import { useEffect, useState } from 'react';
import type { FoodItem, Meal } from '@fitness-coach/shared';
import { api, type DailyEntryView } from '../api/client.js';

type MealView = DailyEntryView['meals'][number];
type DraftItem = Pick<FoodItem, 'id' | 'name' | 'amount' | 'unit' | 'cooking_method' | 'confidence' | 'needs_confirmation' | 'is_user_confirmed' | 'notes'>;

const statusLabels: Record<Meal['recognition_status'], string> = {
  unrecognized: '尚未识别', processing: '识别中', needs_review: '待确认', confirmed: '已确认', failed: '识别失败',
};

function toDraft(item: FoodItem): DraftItem {
  return { id: item.id, name: item.name, amount: item.amount, unit: item.unit, cooking_method: item.cooking_method, confidence: item.confidence, needs_confirmation: item.needs_confirmation, is_user_confirmed: item.is_user_confirmed, notes: item.notes ?? '' };
}

export function MealDetailPage({ date, mealId, onBack }: { date: string; mealId: number; onBack?: () => void }) {
  const [meal, setMeal] = useState<MealView | null>(null);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [recognizing, setRecognizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.getDailyEntry(date).then((entry) => {
      if (!active) return;
      const saved = entry?.meals.find((item) => item.id === mealId) ?? null;
      setMeal(saved);
      setDrafts(saved?.food_items.map(toDraft) ?? []);
      setError(saved ? '' : '找不到这餐记录');
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : '读取餐次失败'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [date, mealId]);

  async function recognize() {
    if (!meal || recognizing || saving || meal.recognition_status === 'processing') return;
    setRecognizing(true); setError('');
    setMeal((current) => current ? { ...current, recognition_status: 'processing' } : current);
    try {
      const result = await api.recognizeMeal(meal.id);
      setMeal({ ...meal, ...result.meal, food_items: result.food_items });
      setDrafts(result.food_items.map(toDraft));
    } catch (cause) {
      setMeal((current) => current ? { ...current, recognition_status: 'failed' } : current);
      setError(cause instanceof Error ? cause.message : '识别失败，请重试');
    }
    finally { setRecognizing(false); }
  }

  async function confirm() {
    if (!meal || recognizing || saving || !editable) return;
    setSaving(true); setError('');
    try {
      const result = await api.confirmFoodItems(meal.id, { items: drafts.map(({ is_user_confirmed: _isUserConfirmed, ...item }) => item) });
      setMeal({ ...meal, ...result.meal, food_items: result.food_items });
      setDrafts(result.food_items.map(toDraft));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '确认食物项目失败'); }
    finally { setSaving(false); }
  }

  function updateDraft(index: number, field: keyof DraftItem, value: string) {
    setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: field === 'amount' || field === 'confidence' ? Number(value) : value } : item));
  }

  if (loading) return <main className="page-shell"><p>正在读取餐次...</p></main>;
  if (!meal) return <main className="page-shell"><div className="read-error" role="alert">{error || '找不到这餐记录'}</div></main>;
  const hasUnconfirmedModelDraft = meal.food_items.some((item) => item.source === 'model' && !item.is_user_confirmed);
  const editable = meal.recognition_status === 'needs_review' || (meal.recognition_status === 'failed' && hasUnconfirmedModelDraft);
  const showEditor = editable || recognizing;

  return <main className="page-shell meal-detail-page">
    <div className="page-kicker">餐次详情 / {date}</div>
    <div className="page-title-row"><div><h1>{meal.notes || meal.meal_type}</h1><p>识别只会在你点击按钮后进行，图片始终保存在本机。</p></div><span className="status-pill">{recognizing ? '识别中' : statusLabels[meal.recognition_status]}</span></div>
    {error && <div className="read-error" role="alert"><span>{error}</span></div>}
    <section className="panel meal-detail-panel"><div className="section-heading"><div><span className="eyebrow">本地图片</span><h2>这餐的图片</h2></div><span className="muted">{meal.images.length} 张</span></div><div className="meal-detail-images">{meal.images.map((image) => image.warning ? <div className="image-warning" key={image.id}>图片缺失：{image.warning}</div> : <img key={image.id} src={`/api/images/${image.id}`} alt="本地餐次图片" />)}</div>{!meal.images.length && <p className="muted">没有可展示的本地图片。</p>}</section>
    <section className="panel meal-detail-panel"><div className="section-heading"><div><span className="eyebrow">结构化结果</span><h2>食物项目</h2></div><span className="tag">{statusLabels[meal.recognition_status]}</span></div>
       {(meal.recognition_status === 'unrecognized' || meal.recognition_status === 'processing') && <p className="muted">{statusLabels[meal.recognition_status]}</p>}
      {meal.recognition_status === 'confirmed' && <p className="save-status save-status--success">已确认</p>}
      {meal.recognition_status === 'failed' && !hasUnconfirmedModelDraft && <p className="muted">识别失败后没有可确认的识别草稿，请重试识别。</p>}
       {showEditor && <div className="food-items-editor">{drafts.map((item, index) => <div className="food-item-editor" key={item.id ?? `new-${index}`}><div className="form-grid form-grid--four"><label>名称<input disabled={recognizing || saving} aria-label={`食物名称 ${index + 1}`} value={item.name} onChange={(event) => updateDraft(index, 'name', event.target.value)} /></label><label>份量<input disabled={recognizing || saving} aria-label={`份量 ${index + 1}`} type="number" min="0.01" step="0.01" value={item.amount} onChange={(event) => updateDraft(index, 'amount', event.target.value)} /></label><label>单位<input disabled={recognizing || saving} aria-label={`单位 ${index + 1}`} value={item.unit} onChange={(event) => updateDraft(index, 'unit', event.target.value)} /></label><label>烹饪方式<input disabled={recognizing || saving} aria-label={`烹饪方式 ${index + 1}`} value={item.cooking_method} onChange={(event) => updateDraft(index, 'cooking_method', event.target.value)} /></label></div><label>备注<textarea disabled={recognizing || saving} aria-label={`食物备注 ${index + 1}`} value={item.notes ?? ''} onChange={(event) => updateDraft(index, 'notes', event.target.value)} /></label><div className="food-item-meta"><span className="muted">{item.is_user_confirmed ? '人工确认' : '模型估计 / 待确认'}</span>{!item.is_user_confirmed && <button disabled={recognizing || saving} className="button button--quiet button--danger" type="button" aria-label={`删除食物项目 ${index + 1}`} onClick={() => setDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index))}>删除项目</button>}</div></div>)}<div className="food-editor-actions"><button disabled={recognizing || saving} className="button button--quiet" type="button" onClick={() => setDrafts((current) => [...current, { name: '', amount: 1, unit: '份', cooking_method: '', confidence: 1, needs_confirmation: true, is_user_confirmed: false, notes: '' }])}>添加食物项目</button><button className="button button--dark" type="button" disabled={saving || recognizing || !editable} onClick={() => void confirm()}>确认食物项目</button></div></div>}
      {!editable && meal.recognition_status !== 'unrecognized' && meal.recognition_status !== 'processing' && <div className="food-item-list">{meal.food_items.map((item) => <div className="food-item-row" key={item.id}><strong>{item.name}</strong><span>{item.amount} {item.unit}</span><span>{item.cooking_method || '未填写烹饪方式'}</span><span className="muted">{item.notes}</span></div>)}</div>}
       <div className="meal-detail-actions"><button className="button button--dark" type="button" disabled={saving || recognizing || meal.recognition_status === 'processing'} onClick={() => void recognize()}>{recognizing ? '识别中...' : '识别这餐'}</button>{onBack && <button className="button button--quiet" type="button" onClick={onBack}>返回日记录</button>}</div>
    </section>
  </main>;
}
