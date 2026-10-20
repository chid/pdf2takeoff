export interface Trade {id:string;name:string;audience:string;headline:string;intro:string;items:{code:string;description:string}[];question:string;detail:string;outside:string;diagram:string;colour:string}
export const trades:Trade[];
export function getTrade(id:string|null):Trade;
