export interface PricedLine {code:string;quantity:number|null;unresolved:number|null;materialCents:number|null;labourCents:number|null;source:string;status:'out-of-scope'|'quantity-not-assessed'|'rate-required'|'review-required'|'priced';totalCents:number|null}
export function moneyCents(value:unknown):number|null;
export function priceQuantities(quantities:{code:string;status:string;supported:number|null;unresolved:number|null}[],rates:Record<string,{material?:string;labour?:string;source?:string}>):{lines:PricedLine[];pricedSubtotalCents:number;complete:boolean};
