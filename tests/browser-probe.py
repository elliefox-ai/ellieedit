import asyncio, json, os
from playwright.async_api import async_playwright

os.makedirs('.probes', exist_ok=True)

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
        # 4. Full ladder to completion: results view + post-save grid state
        const_clear = "() => [...document.querySelectorAll('button')].find(b=>b.dataset.act==='clear-sel')?.click()"
        await pg.evaluate(const_clear)
        await pg.evaluate("() => [...document.querySelectorAll('.rv-cell')].slice(0,4).forEach(c=>c.click())")
        await pg.evaluate("() => [...document.querySelectorAll('button')].find(b=>/^Review \\d/.test(b.textContent.trim()))?.click()")
        await pg.wait_for_timeout(900)
        ladder_clicks = []
        for _ in range(4):
            btn = await pg.query_selector('button[data-act="keep-champion"]')
            done = await pg.evaluate("() => !!document.querySelector('[data-id=\\'results\\']') && document.querySelector('[data-id=\\'results\\']').style.display !== 'none'")
            if done:
                break
            await btn.click()
            ladder_clicks.append('keep-champion')
            await pg.wait_for_timeout(600)
        results_state = await pg.evaluate("""() => {
          const res = document.querySelector('[data-id=results]');
          const vis = res && res.style.display !== 'none';
          return {
            resultsVisible: vis,
            champLabel: document.querySelector('[data-id=res-champ-label]')?.textContent,
            runnerLabel: document.querySelector('[data-id=res-runner-label]')?.textContent,
            summary: document.querySelector('[data-id=res-summary]')?.textContent,
            buttons: [...(res?.querySelectorAll('.rr-actions button')||[])].map(b=>b.textContent.trim()),
            duelVisible: (()=>{const d=document.querySelector('.rv-duel'); return !!d && !d.classList.contains('hidden') && d.getBoundingClientRect().height > 0;})(),
            rejectedVisible: (()=>{const r=document.querySelector('[data-id=rejected]'); return !!r && r.getBoundingClientRect().height > 0;})(),
          };
        }""")
        await pg.screenshot(path='.probes/results-view.png')

        # Redo round -> run again -> Keep Champion & exit -> grid highlight
        await pg.evaluate("() => [...document.querySelectorAll('button')].find(b=>/redo round/i.test(b.textContent)).click()")
        await pg.wait_for_timeout(500)
        for _ in range(4):
            done = await pg.evaluate("() => document.querySelector('[data-id=results]').style.display !== 'none'")
            if done:
                break
            await (await pg.query_selector('button[data-act="keep-champion"]')).click()
            await pg.wait_for_timeout(500)
        champ = await pg.evaluate("() => document.querySelector('[data-id=res-champ-label]').textContent")
        await pg.screenshot(path='.probes/results-after-redo.png')
        await pg.evaluate("() => [...document.querySelectorAll('button')].find(b=>/keep champion/i.test(b.textContent) && b.closest('.rr-actions')).click()")
        await pg.wait_for_timeout(800)
        post_exit = await pg.evaluate("""() => ({
          fullHidden: document.querySelector('[data-id=full]').style.display === 'none',
          selCells: [...document.querySelectorAll('.rv-cell.sel')].map(c=>c.querySelector('.name').textContent),
          toast: [...document.querySelectorAll('body > div')].map(d=>d.textContent).find(t=>/champion kept/i.test(t)) || null,
        })""")
        await pg.screenshot(path='.probes/grid-after-exit.png')

        # Save flow: blend the pair, save, verify toast + highlighted cell
        await pg.evaluate(const_clear)
        await pg.evaluate("() => [...document.querySelectorAll('.rv-cell')].slice(0,4).forEach(c=>c.click())")
        await pg.evaluate("() => [...document.querySelectorAll('button')].find(b=>/^Review \\d/.test(b.textContent.trim()))?.click()")
        await pg.wait_for_timeout(700)
        for _ in range(4):
            done = await pg.evaluate("() => document.querySelector('[data-id=results]') && document.querySelector('[data-id=results]').style.display !== 'none'")
            if done:
                break
            await (await pg.query_selector('button[data-act="keep-champion"]')).click()
            await pg.wait_for_timeout(500)
        await pg.evaluate("() => [...document.querySelectorAll('button')].find(b=>/blend these two/i.test(b.textContent)).click()")
        await pg.wait_for_timeout(1500)
        save_name = 'probe-blend-' + str(os.getpid()) + '.png'
        await pg.fill('[data-id=save-name]', save_name)
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await pg.evaluate("() => [...document.querySelectorAll('button')].find(b=>b.dataset.act==='save').click()")
        await pg.wait_for_timeout(1500)
        post_save = await pg.evaluate("""() => ({
          fullHidden: document.querySelector('[data-id=full]').style.display === 'none',
          selCells: [...document.querySelectorAll('.rv-cell.sel')].map(c=>c.querySelector('.name').textContent),
          toast: [...document.querySelectorAll('body > div')].map(d=>d.textContent).find(t=>/saved/i.test(t)) || null,
        })""")
        await pg.screenshot(path='.probes/grid-after-save.png')

        print(json.dumps({"thumbCheck": check, "duelClicks": duel, "ipad": ipad,
                          "ladderClicks": ladder_clicks, "resultsState": results_state,
                          "championAfterRedo": champ, "postExit": post_exit,
                          "saveName": save_name, "postSave": post_save}, indent=1))
        await b.close()

asyncio.run(main())
