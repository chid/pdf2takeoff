// Drawing navigation uses viewport coordinates, before CSS zoom. PDF point
// conversion remains owned by pdf.js (and therefore respects page rotation).
export interface XY { x:number; y:number }
export interface Box { left:number; top:number; width:number; height:number }
export const MIN_ZOOM=0.05;
export const MAX_ZOOM=8;
export const clampZoom=(value:number)=>Math.min(MAX_ZOOM,Math.max(MIN_ZOOM,value));
export function fitScale(page:XY,available:XY,mode:'page'|'width',padding=48):number {
  const width=Math.max(1,available.x-padding)/page.x;
  const height=Math.max(1,available.y-padding)/page.y;
  return clampZoom(mode==='width'?width:Math.min(width,height));
}
export function pageAnchor(screen:XY,box:Box,page:XY):XY {
  return {x:(screen.x-box.left)*page.x/box.width,y:(screen.y-box.top)*page.y/box.height};
}
export function anchoredScroll(scroll:XY,box:Box,anchor:XY,zoom:number,screen:XY):XY {
  return {x:scroll.x+box.left+anchor.x*zoom-screen.x,y:scroll.y+box.top+anchor.y*zoom-screen.y};
}
