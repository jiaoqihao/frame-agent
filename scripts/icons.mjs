import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {Resvg} from '@resvg/resvg-js';
const source=readFileSync(new URL('../public/frame.svg',import.meta.url),'utf8');
const directory=new URL('../public/icons/',import.meta.url);mkdirSync(directory,{recursive:true});
for(const size of [16,32,48,128])writeFileSync(new URL(`frame-${size}.png`,directory),new Resvg(source,{fitTo:{mode:'width',value:size}}).render().asPng());
