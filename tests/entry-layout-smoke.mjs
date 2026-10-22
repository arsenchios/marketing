import express from 'express';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { initialEvent } from '../shared/contracts.ts';
const app=express();
let cover=false;
app.get('/api/room/layout/info',(_,res)=>res.json({...initialEvent,id:'layout',slug:'layout',state:'draft',title:'Бизнес без границ',description:'Как подготовиться к вебинару и обсудить важные вопросы',startsAt:new Date(Date.now()+7200000).toISOString(),timezone:'Europe/Moscow',coverId:cover?'cover':null}));
app.get('/api/room/layout',(_,res)=>res.status(401).json({error:'Join first'}));
app.get('/api/events/layout/assets/cover',(_,res)=>res.type('svg').send('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#684050"/></svg>'));
app.use(express.static(resolve('dist')));
app.get('/{*path}',(_,res)=>res.sendFile(resolve('dist/index.html')));
const server=app.listen(4329,'127.0.0.1');
const browser=await chromium.launch({channel:'chrome',headless:true});
mkdirSync('test-results/entry-layout',{recursive:true});
try {
 const page=await browser.newPage();
 for(const width of [1440,1024,768,390,320]) {
 await page.setViewportSize({width,height:1000});
 await page.goto('http://127.0.0.1:4329/room/layout');
 await page.locator('.join-intro h1').filter({hasText:'Бизнес без границ'}).waitFor();
 const form=await page.locator('.join-form').boundingBox(), intro=await page.locator('.join-intro').boundingBox();
 assert(width>800 ? form.x+form.width<intro.x : intro.y+intro.height<form.y);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:`test-results/entry-layout/${width}.png`,fullPage:true});
 }
 cover=true;
 await page.reload();
 await page.locator('.join-cover').waitFor();
 assert(await page.locator('.join-cover').evaluate(img=>img.complete&&img.naturalWidth>0));
 console.log('PASS entry layout 320–1440px, form order, overflow, uploaded cover');
}finally {await browser.close();server.close();}
