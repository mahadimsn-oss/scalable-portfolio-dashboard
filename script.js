const $=id=>document.getElementById(id);
let headers=[],rows=[],filtered=[],stockSort={key:"description",direction:"asc"};
const currentPrices={};

function norm(v){return String(v??"").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function num(v){
    if(typeof v==="number")return v;
    let s=String(v??"").trim().replace(/\s/g,"").replace(/[€$£]/g,"");
    if(!s)return 0;
    if(s.includes(",")&&s.includes("."))s=s.lastIndexOf(",")>s.lastIndexOf(".")?s.replace(/\./g,"").replace(",","."):s.replace(/,/g,"");
    else if(s.includes(","))s=s.replace(",",".");
    const n=Number(s);
    return Number.isFinite(n)?n:0;
}
function money(v){return new Intl.NumberFormat("de-DE",{style:"currency",currency:"EUR"}).format(v||0)}
function pct(v){return new Intl.NumberFormat("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2}).format(v||0)+" %"}
function qty(v){return Number(v||0).toLocaleString("de-DE",{maximumFractionDigits:8})}
function profitClass(el,v){el.classList.remove("good","bad");if(v>0)el.classList.add("good");if(v<0)el.classList.add("bad")}
function col(...names){for(const n of names){const i=headers.findIndex(h=>norm(h)===norm(n));if(i>=0)return i}return-1}
function objs(){return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??""])))}
function val(r,c){const k=headers.find(h=>norm(h)===norm(c));return k?r[k]:""}
function executed(r){const s=norm(val(r,"STATUS"));return !s||["executed","completed","done","gebucht","ausgeführt","ausgefuhrt"].some(x=>s.includes(x))}
function buy(r){const t=norm(val(r,"TYPE"));return t==="buy"||t==="kauf"||t==="savings plan"||t==="sparplan"}
function sell(r){const t=norm(val(r,"TYPE"));return t==="sell"||t==="verkauf"}
function distribution(r){return norm(val(r,"TYPE"))==="distribution"}
function corporate(r){return norm(val(r,"TYPE"))==="corporate action"}

function delimiter(text){
    const l=text.split(/\r?\n/).find(x=>x.trim())||"";
    return[";",",","\t"].sort((a,b)=>l.split(b).length-l.split(a).length)[0];
}
function csv(text,d){
    const out=[];let row=[],f="",q=false;
    for(let i=0;i<text.length;i++){
        const c=text[i],n=text[i+1];
        if(c==='"'){if(q&&n==='"'){f+='"';i++}else q=!q}
        else if(c===d&&!q){row.push(f);f=""}
        else if((c==="\r"||c==="\n")&&!q){
            if(c==="\r"&&n==="\n")i++;
            row.push(f);f="";
            if(row.some(x=>x.trim()!==""))out.push(row);
            row=[];
        }else f+=c;
    }
    if(f.length||row.length){row.push(f);out.push(row)}
    return out;
}

function renderTable(id,data,columns=headers,max=1000){
    const e=$(id);
    if(!data.length){e.innerHTML='<div class="note">No matching rows.</div>';return}
    e.innerHTML="<table><thead><tr>"+columns.map(c=>`<th>${esc(c)}</th>`).join("")+"</tr></thead><tbody>"+
        data.slice(0,max).map(r=>"<tr>"+columns.map(c=>`<td>${esc(r[c]??"")}</td>`).join("")+"</tr>").join("")+
        "</tbody></table>";
}

function aliases(){
    const parent={};
    const find=x=>{if(!parent[x])parent[x]=x;if(parent[x]!==x)parent[x]=find(parent[x]);return parent[x]};
    const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[a]=b};
    const groups={};

    objs().filter(r=>executed(r)&&corporate(r)).forEach(r=>{
        const k=val(r,"DATE")+"|"+val(r,"TIME");
        (groups[k]??=[]).push(r);
    });

    Object.values(groups).forEach(g=>{
        const neg=g.filter(r=>num(val(r,"SHARES"))<0&&val(r,"ISIN"));
        const pos=g.filter(r=>num(val(r,"SHARES"))>0&&val(r,"ISIN"));
        if(neg.length===1&&pos.length===1&&neg[0]&&pos[0]&&val(neg[0],"ISIN")!==val(pos[0],"ISIN"))
            union(val(neg[0],"ISIN"),val(pos[0],"ISIN"));
    });

    return{find,groups};
}

function engine(){
    const all=objs().filter(executed);
    const {find,groups}=aliases();
    const lots={},stats={};

    const stat=isin=>{
        const k=find(isin);
        if(!stats[k])stats[k]={isin:k,invested:0,sold:0,bought:0,soldShares:0,buyTransactions:0,sellTransactions:0,fees:0,distributions:0,tradingPL:0,unmatched:0};
        if(!lots[k])lots[k]=[];
        return stats[k];
    };

    const sorted=[...all].sort((a,b)=>(val(a,"DATE")+" "+val(a,"TIME")).localeCompare(val(b,"DATE")+" "+val(b,"TIME")));
    const doneCorporate=new Set();

    for(const r of sorted){
        const isin=val(r,"ISIN");
        if(!isin)continue;
        const k=find(isin),s=stat(k),type=norm(val(r,"TYPE"));
        const sh=Math.abs(num(val(r,"SHARES"))),amount=num(val(r,"AMOUNT")),fee=Math.abs(num(val(r,"FEE")));

        if(buy(r)&&sh>0){
            const cost=Math.abs(amount)+fee;
            lots[k].push({q:sh,c:cost/sh});
            s.invested+=Math.abs(amount);
            s.bought+=sh;
            s.buyTransactions++;
            s.fees+=fee;
            continue;
        }

        if(sell(r)&&sh>0){
            let q=sh,cost=0,matched=0;
            while(q>1e-9&&lots[k].length){
                const lot=lots[k][0],u=Math.min(q,lot.q);
                cost+=u*lot.c;
                matched+=u;
                lot.q-=u;
                q-=u;
                if(lot.q<=1e-9)lots[k].shift();
            }
            if(q>1e-9)s.unmatched+=q;
            const ratio=matched/sh;
            const proceeds=Math.abs(amount)*ratio-fee*ratio;
            s.tradingPL+=proceeds-cost;
            s.sold+=Math.abs(amount);
            s.soldShares+=sh;
            s.sellTransactions++;
            s.fees+=fee;
            continue;
        }

        if(distribution(r)){
            s.distributions+=amount;
            continue;
        }

        if(corporate(r)){
            const gk=val(r,"DATE")+"|"+val(r,"TIME");
            if(doneCorporate.has(gk))continue;
            doneCorporate.add(gk);
            const g=groups[gk]||[];
            const neg=g.filter(x=>num(val(x,"SHARES"))<0);
            const pos=g.filter(x=>num(val(x,"SHARES"))>0);

            if(neg.length===1&&pos.length===1){
                const oldKey=find(val(neg[0],"ISIN")),newKey=find(val(pos[0],"ISIN"));
                const oldQ=Math.abs(num(val(neg[0],"SHARES"))),newQ=Math.abs(num(val(pos[0],"SHARES")));
                if(oldQ>0&&newQ>0){
                    const ratio=newQ/oldQ;
                    const target=lots[oldKey]||[];
                    target.forEach(l=>{l.q*=ratio;l.c/=ratio});
                    if(oldKey!==newKey){lots[newKey]=(lots[newKey]||[]).concat(target);lots[oldKey]=[]}
                }
            }else if(pos.length&&!neg.length){
                pos.forEach(x=>{
                    const kk=find(val(x,"ISIN")),q=Math.abs(num(val(x,"SHARES")));
                    stat(kk);
                    if(q>0)lots[kk].push({q,c:0});
                });
            }else if(neg.length===1&&!pos.length){
                const x=neg[0],kk=find(val(x,"ISIN")),q=Math.abs(num(val(x,"SHARES"))),cash=Math.abs(num(val(x,"AMOUNT")));
                if(q>0&&cash>0){
                    let left=q,cost=0,matched=0;
                    while(left>1e-9&&lots[kk].length){
                        const lot=lots[kk][0],u=Math.min(left,lot.q);
                        cost+=u*lot.c;matched+=u;lot.q-=u;left-=u;
                        if(lot.q<=1e-9)lots[kk].shift();
                    }
                    const ss=stat(kk);
                    if(left>1e-9)ss.unmatched+=left;
                    if(matched>0)ss.tradingPL+=cash*(matched/q)-cost;
                }
            }
        }
    }

    Object.keys(stats).forEach(k=>{
        stats[k].remainingShares=(lots[k]||[]).reduce((t,l)=>t+l.q,0);
        stats[k].remainingCost=(lots[k]||[]).reduce((t,l)=>t+l.q*l.c,0);
        stats[k].currentAvg=stats[k].remainingShares?stats[k].remainingCost/stats[k].remainingShares:0;
        stats[k].realized=stats[k].tradingPL+stats[k].distributions;
        stats[k].incomplete=stats[k].unmatched>1e-9;
    });

    return{stats,find};
}

function getStockInfo(){
    const {find}=aliases(),m=new Map();
    objs().forEach(r=>{
        const isin=val(r,"ISIN"),asset=norm(val(r,"ASSETTYPE"));
        if(!isin||(asset&&asset!=="security"))return;
        const k=find(isin),d=String(val(r,"DESCRIPTION")||"").trim();
        if(!m.has(k))m.set(k,{isin:k,description:d});
        else if(d.length>m.get(k).description.length)m.get(k).description=d;
    });
    return m;
}

function populateFilters(){
    const m=[...getStockInfo().values()].sort((a,b)=>a.description.localeCompare(b.description,undefined,{sensitivity:"base"}));
    $("stockFilter").innerHTML='<option value="">All stocks</option>'+m.map(s=>`<option value="${esc(s.isin)}">${esc((s.description||s.isin)+" ("+s.isin+")")}</option>`).join("");

    const ti=col("TYPE"),si=col("STATUS"),di=col("DATE");
    if(ti>=0){
        const v=[...new Set(rows.map(r=>r[ti]).filter(Boolean))].sort();
        $("typeFilter").innerHTML='<option value="">All types</option>'+v.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("");
    }
    if(si>=0){
        const v=[...new Set(rows.map(r=>r[si]).filter(Boolean))].sort();
        $("statusFilter").innerHTML='<option value="">All statuses</option>'+v.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("");
    }
    if(di>=0){
        const d=[...new Set(rows.map(r=>r[di]).filter(Boolean))].sort();
        if(d.length){$("fromDate").value=d[0];$("toDate").value=d[d.length-1]}
    }
}

function analysisFor(isin){
    const {stats,find}=engine(),k=find(isin);
    const s=stats[k]||{invested:0,sold:0,bought:0,soldShares:0,buyTransactions:0,sellTransactions:0,fees:0,distributions:0,tradingPL:0,realized:0,remainingShares:0,remainingCost:0,currentAvg:0,unmatched:0,incomplete:false};
    return s;
}

function breakEven(a){
    if(a.remainingShares<=0)return null;
    const b=(a.remainingCost-a.realized)/a.remainingShares;
    return b<=0?0:b;
}

function updateDashboard(){
    const isin=$("stockFilter").value;
    const a=isin?analysisFor(isin):aggregateSelection();
    const price=isin?num($("currentPrice").value):0;
    const market=a.remainingShares*price;
    const unrealized=price>0?market-a.remainingCost:0;
    const total=a.realized+unrealized;
    const uret=price>0&&a.remainingCost>0?unrealized/a.remainingCost*100:0;
    const be=breakEven(a);

    $("mRows").textContent=filtered.length;
    $("mInvested").textContent=money(a.invested);
    $("mSold").textContent=money(a.sold);
    $("mRealized").textContent=money(a.realized);
    $("mUnrealized").textContent=!isin?"Select stock":price>0?money(unrealized):"Enter current price";
    $("mTotalPL").textContent=price>0?money(total):money(a.realized);

    profitClass($("mRealized"),a.realized);
    profitClass($("mUnrealized"),unrealized);
    profitClass($("mTotalPL"),price>0?total:a.realized);

    $("pShares").textContent=qty(a.remainingShares);
    $("pAvgCost").textContent=a.remainingShares?money(a.currentAvg):"—";
    $("pBreakEven").textContent=be===null?"—":be===0?"Already profitable":money(be);
    $("pCurrentPrice").textContent=price>0?money(price):"—";
    $("pMarketValue").textContent=price>0?money(market):"—";
    $("pUnrealizedReturn").textContent=price>0?pct(uret):"—";
    profitClass($("pUnrealizedReturn"),uret);

    $("positionHint").textContent=!isin?"Select one stock to calculate its current position.":price<=0?"Enter the current market price above.":"Calculated using the current price entered by you.";

    const status=a.incomplete?`<span class="warning">Incomplete (${qty(a.unmatched)} unmatched shares)</span>`:'<span class="good">OK</span>';

    $("stockSummary").innerHTML=`
    <div>Buy transactions</div><div><b>${a.buyTransactions}</b></div>
    <div>Sell transactions</div><div><b>${a.sellTransactions}</b></div>
    <div>Total invested</div><div><b>${money(a.invested)}</b></div>
    <div>Total sale proceeds</div><div><b>${money(a.sold)}</b></div>
    <div>Shares bought</div><div><b>${qty(a.bought)}</b></div>
    <div>Shares sold</div><div><b>${qty(a.soldShares)}</b></div>
    <div>Shares currently held</div><div><b>${qty(a.remainingShares)}</b></div>
    <div>Current average cost</div><div><b>${a.remainingShares?money(a.currentAvg):"—"}</b></div>
    <div>Remaining FIFO cost basis</div><div><b>${money(a.remainingCost)}</b></div>
    <div>Break-even price</div><div><b>${be===null?"—":be===0?"Already profitable":money(be)}</b></div>
    <div>Trading realized P/L</div><div class="${a.tradingPL>=0?"good":"bad"}"><b>${money(a.tradingPL)}</b></div>
    <div>Distributions</div><div class="${a.distributions>=0?"good":"bad"}"><b>${money(a.distributions)}</b></div>
    <div>Realized P/L incl. distributions</div><div class="${a.realized>=0?"good":"bad"}"><b>${money(a.realized)}</b></div>
    <div>Current market value</div><div><b>${price>0?money(market):"—"}</b></div>
    <div>Unrealized P/L</div><div class="${unrealized>=0?"good":"bad"}"><b>${!isin?"Select stock":price>0?money(unrealized):"Enter current price"}</b></div>
    <div>Total P/L</div><div class="${total>=0?"good":"bad"}"><b>${price>0?money(total):money(a.realized)}</b></div>
    <div>Cost basis status</div><div>${status}</div>`;
}

function aggregateSelection(){
    const {stats}=engine();
    return Object.values(stats).reduce((a,s)=>{
        a.invested+=s.invested;a.sold+=s.sold;a.bought+=s.bought;a.soldShares+=s.soldShares;
        a.buyTransactions+=s.buyTransactions;a.sellTransactions+=s.sellTransactions;a.fees+=s.fees;
        a.distributions+=s.distributions;a.tradingPL+=s.tradingPL;a.realized+=s.realized;
        a.remainingShares+=s.remainingShares;a.remainingCost+=s.remainingCost;a.unmatched+=s.unmatched;
        return a;
    },{invested:0,sold:0,bought:0,soldShares:0,buyTransactions:0,sellTransactions:0,fees:0,distributions:0,tradingPL:0,realized:0,remainingShares:0,remainingCost:0,currentAvg:0,unmatched:0,incomplete:false});
}

function sortArrow(k){return stockSort.key===k?(stockSort.direction==="asc"?" ▲":" ▼"):""}
function setStockSort(k){
    if(stockSort.key===k)stockSort.direction=stockSort.direction==="asc"?"desc":"asc";
    else{stockSort.key=k;stockSort.direction=k==="description"?"asc":"desc"}
    buildAllStocksSummary();
}
window.setStockSort=setStockSort;

function sortStocks(data){
    const d=stockSort.direction==="asc"?1:-1;
    return data.sort((a,b)=>{
        let x,y;
        switch(stockSort.key){
            case"description":return String(a.description).localeCompare(String(b.description),undefined,{sensitivity:"base"})*d;
            case"bought":x=a.a.bought;y=b.a.bought;break;
            case"sold":x=a.a.soldShares;y=b.a.soldShares;break;
            case"held":x=a.a.remainingShares;y=b.a.remainingShares;break;
            case"avgCost":x=a.a.currentAvg;y=b.a.currentAvg;break;
            case"realized":x=a.a.realized;y=b.a.realized;break;
            case"breakEven":x=a.be??Infinity;y=b.be??Infinity;break;
            case"currentPrice":x=a.price||0;y=b.price||0;break;
            case"marketValue":x=a.market??0;y=b.market??0;break;
            case"unrealized":x=a.unrealized??0;y=b.unrealized??0;break;
            case"total":x=a.total??0;y=b.total??0;break;
            default:return 0;
        }
        return(x-y)*d;
    });
}

function buildAllStocksSummary(){
    if(!rows.length){$("allStocksTable").innerHTML='<div class="note">No CSV loaded.</div>';return}

    const stocks=getStockInfo(),data=[];

    for(const s of stocks.values()){
        const a=analysisFor(s.isin),price=Number(currentPrices[s.isin]||0);
        const market=price>0?a.remainingShares*price:null;
        const unrealized=price>0?market-a.remainingCost:null;
        const total=price>0?a.realized+unrealized:a.realized;
        data.push({description:s.description||s.isin,isin:s.isin,a,price,market,unrealized,total,be:breakEven(a)});
    }

    const visibleData=$("hideClosed")?.checked?data.filter(x=>x.a.remainingShares>1e-8):data;
    sortStocks(visibleData);

    let html=`<table><thead><tr>
    <th class="sortable" onclick="setStockSort('description')">Stock${sortArrow("description")}</th>
    <th>ISIN</th>
    <th class="sortable" onclick="setStockSort('bought')">Bought${sortArrow("bought")}</th>
    <th class="sortable" onclick="setStockSort('sold')">Sold${sortArrow("sold")}</th>
    <th class="sortable" onclick="setStockSort('held')">Held${sortArrow("held")}</th>
    <th class="sortable" onclick="setStockSort('avgCost')">Current Avg Cost${sortArrow("avgCost")}</th>
    <th class="sortable" onclick="setStockSort('realized')">Realized P/L${sortArrow("realized")}</th>
    <th>Distributions</th>
    <th class="sortable" onclick="setStockSort('breakEven')">Break-even${sortArrow("breakEven")}</th>
    <th class="sortable" onclick="setStockSort('currentPrice')">Current Price${sortArrow("currentPrice")}</th>
    <th class="sortable" onclick="setStockSort('marketValue')">Market Value${sortArrow("marketValue")}</th>
    <th class="sortable" onclick="setStockSort('unrealized')">Unrealized P/L${sortArrow("unrealized")}</th>
    <th class="sortable" onclick="setStockSort('total')">Total P/L${sortArrow("total")}</th>
    <th>Cost Basis</th></tr></thead><tbody>`;

    visibleData.forEach(x=>{
        const a=x.a;
        html+=`<tr>
        <td>${esc(x.description)}</td>
        <td>${esc(x.isin)}</td>
        <td>${qty(a.bought)}</td>
        <td>${qty(a.soldShares)}</td>
        <td><b>${qty(a.remainingShares)}</b></td>
        <td>${a.remainingShares?money(a.currentAvg):"—"}</td>
        <td class="${a.realized>=0?"good":"bad"}"><b>${money(a.realized)}</b></td>
        <td class="${a.distributions>=0?"good":"bad"}">${money(a.distributions)}</td>
        <td><b>${x.be===null?"—":x.be===0?"Already profitable":money(x.be)}</b></td>
        <td>
    ${x.price>0?money(x.price):"—"}
</td>
        <td>${x.market===null?"—":money(x.market)}</td>
        <td class="${x.unrealized===null?"":x.unrealized>=0?"good":"bad"}">${x.unrealized===null?"—":`<b>${money(x.unrealized)}</b>`}</td>
        <td class="${x.total>=0?"good":"bad"}"><b>${money(x.total)}</b></td>
        <td>${a.incomplete?'<span class="warning">Incomplete</span>':'<span class="good">OK</span>'}</td>
        </tr>`;
    });

    $("allStocksTable").innerHTML=html+"</tbody></table>";
}

function updatePortfolioSummary(){
    const {stats}=engine();
    const all=objs().filter(executed);

    let tradingPL=0,distributions=0,marketValue=0,unrealizedPL=0;

    Object.values(stats).forEach(a=>{
        tradingPL+=a.tradingPL;
        distributions+=a.distributions;

        const price=Number(currentPrices[a.isin]||0);

        if(price>0&&a.remainingShares>0){
            const value=a.remainingShares*price;
            marketValue+=value;
            unrealizedPL+=value-a.remainingCost;
        }
    });

    const taxRefunds=all
        .filter(r=>norm(val(r,"TYPE"))==="taxes")
        .reduce((sum,r)=>sum+num(val(r,"AMOUNT")),0);

    const realizedTotal=tradingPL+distributions+taxRefunds;
    const estimatedTotal=realizedTotal+unrealizedPL;

    $("portfolioTradingPL").textContent=money(tradingPL);
    $("portfolioDistributions").textContent=money(distributions);
    $("portfolioTaxRefunds").textContent=money(taxRefunds);
    $("portfolioRealized").textContent=money(realizedTotal);
    $("portfolioMarketValue").textContent=money(marketValue);
    $("portfolioTotalPL").textContent=money(estimatedTotal);

    profitClass($("portfolioTradingPL"),tradingPL);
    profitClass($("portfolioDistributions"),distributions);
    profitClass($("portfolioTaxRefunds"),taxRefunds);
    profitClass($("portfolioRealized"),realizedTotal);
    profitClass($("portfolioTotalPL"),estimatedTotal);
}

function applyFilters(){
    const stock=$("stockFilter").value,type=$("typeFilter").value,status=$("statusFilter").value,from=$("fromDate").value,to=$("toDate").value;
    const {find}=aliases();

    filtered=objs().filter(r=>{
        const isin=val(r,"ISIN"),date=val(r,"DATE");
        return(!stock||find(isin)===stock)&&(!type||val(r,"TYPE")===type)&&(!status||val(r,"STATUS")===status)&&(!from||date>=from)&&(!to||date<=to);
    });

    updateDashboard();
    renderTable("dataTable",filtered,headers,1000);
}

function updateEverything(){
    applyFilters();
    buildAllStocksSummary();
    updatePortfolioSummary();
}

$("applyPricesBtn").addEventListener("click",applyPricesFromTextarea);
$("clearPricesBtn").addEventListener("click",clearCurrentPrices);
$("applyBtn").addEventListener("click",updateEverything);
$("hideClosed").addEventListener("change",buildAllStocksSummary);
$("stockFilter").addEventListener("change",()=>{
    const s=$("stockFilter").value;
    $("currentPrice").disabled=!s;
    $("currentPrice").value=s&&currentPrices[s]?currentPrices[s]:"";
    updateEverything();
    refreshPriceTextarea();
});
$("currentPrice").addEventListener("change",()=>{
    const s=$("stockFilter").value;
    if(!s)return;
    const p=num($("currentPrice").value);
    if(p>0)currentPrices[s]=p;else delete currentPrices[s];
    updateEverything();
});
$("typeFilter").addEventListener("change",updateEverything);
$("statusFilter").addEventListener("change",updateEverything);
$("fromDate").addEventListener("change",updateEverything);
$("toDate").addEventListener("change",updateEverything);

$("resetBtn").addEventListener("click",()=>{
    $("stockFilter").value="";
    $("currentPrice").value="";
    $("currentPrice").disabled=true;
    $("typeFilter").value="";
    $("statusFilter").value="";
    const i=col("DATE"),dates=i>=0?[...new Set(rows.map(r=>r[i]).filter(Boolean))].sort():[];
    if(dates.length){$("fromDate").value=dates[0];$("toDate").value=dates[dates.length-1]}
    updateEverything();
});

$("fileInput").addEventListener("change",e=>{
    const file=e.target.files[0];
    if(!file)return;
    const reader=new FileReader();

    reader.onload=e=>{
        const text=String(e.target.result).replace(/^\uFEFF/,"");
        const parsed=csv(text,delimiter(text));
        if(parsed.length<2){alert("The CSV contains no transaction rows.");return}

        headers=parsed[0].map((h,i)=>h.trim()||`Column ${i+1}`);
        rows=parsed.slice(1).map(r=>headers.map((_,i)=>String(r[i]??"").trim()));

        $("fileInfo").textContent=`${file.name} • ${rows.length.toLocaleString("de-DE")} rows`;
        $("currentPrice").value="";
        $("currentPrice").disabled=true;

        populateFilters();
        updateEverything();
        refreshPriceTextarea();
    };

    reader.readAsText(file);
});
function refreshPriceTextarea(){
    if(!rows.length){
        $("priceTextarea").value="";
        return;
    }

    const stocks=getStockInfo();
    const lines=[];

    for(const stock of stocks.values()){
        const a=analysisFor(stock.isin);
        if(a.remainingShares<=1e-8)continue;

        const price=currentPrices[stock.isin]??"";
        const name=stock.description||stock.isin;

        lines.push(`${name} [${stock.isin}] = ${price}`);
    }

    lines.sort((a,b)=>a.localeCompare(b,undefined,{sensitivity:"base"}));
    $("priceTextarea").value=lines.join("\n");
}

function applyPricesFromTextarea(){
    const lines=$("priceTextarea").value.split(/\r?\n/);
    let updated=0,invalid=0;

    lines.forEach(line=>{
        if(!line.trim())return;

        const match=line.match(/\[([^\]]+)\]\s*=\s*(.*)$/);

        if(!match){
            invalid++;
            return;
        }

        const isin=match[1].trim();
        const raw=match[2].trim();

        if(!raw){
            delete currentPrices[isin];
            return;
        }

        const price=num(raw);

        if(price>0){
            currentPrices[isin]=price;
            updated++;
        }else{
            invalid++;
        }
    });

    const selected=$("stockFilter").value;

    if(selected){
        $("currentPrice").value=
            currentPrices[selected]??"";
    }

    updateDashboard();
    updatePortfolioSummary();
    buildAllStocksSummary();

    $("priceMessage").textContent=
        invalid
            ? `${updated} prices applied, ${invalid} invalid line(s).`
            : `${updated} prices applied.`;
}

function clearCurrentPrices(){
    Object.keys(currentPrices).forEach(k=>delete currentPrices[k]);

    refreshPriceTextarea();

    $("currentPrice").value="";

    updateDashboard();
    updatePortfolioSummary();
    buildAllStocksSummary();

    $("priceMessage").textContent="Current prices cleared.";
}
