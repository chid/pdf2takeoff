// Rates are entered per installed unit in the selected currency. No external pricing.
export function moneyCents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= 100_000_000 ? cents : null;
}
export function priceQuantities(quantities, rates) {
  const lines = quantities.map(q => {
    const rate = rates[q.code] ?? {};
    const materialCents = moneyCents(rate.material);
    const labourCents = moneyCents(rate.labour);
    const quantityKnown = q.status === 'assessed' && Number.isSafeInteger(q.supported) && q.supported >= 0;
    const rateKnown = materialCents !== null && labourCents !== null;
    const unresolved = Number.isSafeInteger(q.unresolved) && q.unresolved >= 0 ? q.unresolved : null;
    const total = quantityKnown && rateKnown ? q.supported * (materialCents + labourCents) : null;
    if (total !== null && !Number.isSafeInteger(total)) throw new RangeError('Line total is too large');
    return { code:q.code, quantity:quantityKnown?q.supported:null, unresolved,
      materialCents, labourCents, source:rate.source??'',
      status:q.status==='out-of-scope'?'out-of-scope':!quantityKnown?'quantity-not-assessed':!rateKnown?'rate-required':unresolved===null||unresolved>0?'review-required':'priced',
      totalCents:total };
  });
  const pricedSubtotalCents = lines.reduce((sum,l)=>sum+(l.totalCents??0),0);
  if (!Number.isSafeInteger(pricedSubtotalCents)) throw new RangeError('Subtotal is too large');
  const scoped=lines.filter(l=>l.status!=='out-of-scope');
  return {lines,pricedSubtotalCents,complete:scoped.length>0&&scoped.every(l=>l.status==='priced')};
}
