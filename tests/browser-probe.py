import asyncio, json
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 900, "height": 700})
        await pg.goto("http://127.0.0.1:8800/", wait_until="networkidle")
        await pg.wait_for_timeout(1200)

        # 1. Thumb aspect check: thumb natural ratio vs declared source dims
        check = await pg.evaluate("""async () => {
          const r = await fetch('/api/gallery/list').then(r=>r.json());
          const out=[];
          for (const it of r.items.slice(0,8)){
            const im = new Image();
            const prom = new Promise(res=>{im.onload=res; im.onerror=res; im.src='/api/gallery/thumb?path='+encodeURIComponent(it.path);});
            await prom;
            out.push({name: it.name, srcDims: it.width+'x'+it.height, thumbDims: im.naturalWidth+'x'+im.naturalHeight});
          }
          return out;
        }""")

        # 2. Duel button semantics: which side changes on each button
        await pg.evaluate("() => [...document.querySelectorAll('[data-tab],[role=tab],.tab,.ee-tab')].find(x=>/review/i.test(x.textContent)).click()")
        await pg.wait_for_timeout(500)
        await pg.evaluate("() => [...document.querySelectorAll('.rv-cell')].slice(0,4).forEach(c=>c.click())")
        await pg.evaluate("() => [...document.querySelectorAll('button')].find(b=>/^Review \\d/.test(b.textContent.trim()))?.click()")
        await pg.wait_for_timeout(900)
        async def left_src():
            return await pg.evaluate("() => [...document.querySelectorAll('img')].filter(i=>!i.closest('.rv-cell') && i.closest('[class*=duel],[class*=stage],[class*=rv-]')).map(i=>i.src.slice(-24))")
        before = await left_src()
        await pg.evaluate("() => [...document.querySelectorAll('button')].find(b=>/keep challenger/i.test(b.textContent)).click()")
        await pg.wait_for_timeout(600)
        afterB = await left_src()
        await pg.evaluate("() => [...document.querySelectorAll('button')].find(b=>/keep champion/i.test(b.textContent)).click()")
        await pg.wait_for_timeout(600)
        afterA = await left_src()
        await pg.evaluate("() => [...document.querySelectorAll('button')].find(b=>/keep challenger/i.test(b.textContent)).click()")
        await pg.wait_for_timeout(600)
        afterB2 = await left_src()
        duel = {"initial": before, "afterKeepChallenger": afterB, "afterKeepChampion": afterA, "afterKeepChallenger2": afterB2,
                "phaseNow": await pg.evaluate("() => (document.body.innerText.match(/Challenger [^\\n]*/)||['done'])[0]")}

        # 3. iPad emulation: are the labels visible?
        ip = await b.new_page(viewport={"width": 1024, "height": 768}, is_mobile=True, has_touch=True)
        await ip.goto("http://127.0.0.1:8800/", wait_until="networkidle")
        await ip.wait_for_timeout(1000)
        await ip.evaluate("() => [...document.querySelectorAll('[data-tab],[role=tab],.tab,.ee-tab')].find(x=>/review/i.test(x.textContent)).click()")
        await ip.wait_for_timeout(400)
        await ip.evaluate("() => [...document.querySelectorAll('.rv-cell')].slice(0,3).forEach(c=>c.click())")
        await ip.evaluate("() => [...document.querySelectorAll('button')].find(b=>/^Review \\d/.test(b.textContent.trim()))?.click()")
        await ip.wait_for_timeout(900)
        ipad = await ip.evaluate("""() => {
          const t=document.body.innerText;
          const champ=[...document.querySelectorAll('*')].find(e=>e.childElementCount===0 && /champion/i.test(e.textContent));
          const vis = champ ? (()=>{const r=champ.getBoundingClientRect(); const cs=getComputedStyle(champ); return {w:r.width|0,h:r.height|0,display:cs.display,visibility:cs.visibility,fontSize:cs.fontSize,color:cs.color};})() : 'not found';
          return {hasChampion: /champion/i.test(t), hasChallenger: /challenger/i.test(t), labelBox: vis};
        }""")
        await ip.screenshot(path="/tmp/shot-ipad-duel.png")
        print(json.dumps({"thumbCheck": check, "duelClicks": duel, "ipad": ipad}, indent=1))
        await b.close()

asyncio.run(main())
