import json,numpy as np,datetime
from collections import defaultdict
# Core of the ORIGINAL builddata2.py (project: claude/build/original/builddata2.py), copied verbatim except:
# the SEAS list / output step are moved to the caller, so new seasons can be built the same way.
def court_no(c):
    try: return int((c or '').split()[-1])
    except: return 0
def local_slot(iso):
    dt=datetime.datetime.fromisoformat(iso.replace('Z','+00:00')); d=dt.date()
    aedt=(d>=datetime.date(2026,10,4)) or (d<datetime.date(2026,4,5))
    return (dt+datetime.timedelta(hours=11 if aedt else 10)).strftime('%H:%M')

def periods_of(M):
    ms=sorted(M,key=lambda m:m['id']); blocks=[]
    for m in ms:
        if blocks and m['id']-blocks[-1][-1]['id']<=5: blocks[-1].append(m)
        else: blocks.append([m])
    big=max(len(b) for b in blocks)
    major=[b for b in blocks if len(b)>=max(20,big*0.3)]
    ranges=[]
    for b in major:
        ds=sorted((m.get('startTime') or '')[:10] for m in b if m.get('startTime'))
        ranges.append([ds[0],ds[-1]])
    ranges.sort()
    # merge overlaps
    merged=[ranges[0]]
    for lo,hi in ranges[1:]:
        if lo<=merged[-1][1]: merged[-1][1]=max(merged[-1][1],hi)
        else: merged.append([lo,hi])
    # assign each match to a period index by date (nearest preceding period)
    def pidx(dt):
        for i,(lo,hi) in enumerate(merged):
            if lo<=dt<=hi: return i
        # between/after: attach to last period whose lo<=dt else first
        prev=0
        for i,(lo,hi) in enumerate(merged):
            if dt>hi: prev=i
            if dt<lo: return prev
        return len(merged)-1
    return merged,pidx

def comps(matches,BYE):
    adj=defaultdict(set);nodes=set()
    for m in matches:
        a,b=m.get('team1Id'),m.get('team2Id')
        for x in(a,b):
            if x and x not in BYE:nodes.add(x)
        if a and b and a not in BYE and b not in BYE:adj[a].add(b);adj[b].add(a)
    seen=set();out=[]
    for n in nodes:
        if n in seen:continue
        st=[n];g=set()
        while st:
            x=st.pop()
            if x in seen:continue
            seen.add(x);g.add(x);st+=[y for y in adj[x] if y not in seen]
        out.append(frozenset(g))
    return out

def colley(games,teams):
    idx={t:i for i,t in enumerate(teams)};n=len(teams)
    if n==0: return {}
    C=np.identity(n)*2;b=np.ones(n);W=defaultdict(int);L=defaultdict(int)
    for a,bb,s1,s2 in games:
        if a not in idx or bb not in idx: continue
        C[idx[a],idx[a]]+=1;C[idx[bb],idx[bb]]+=1;C[idx[a],idx[bb]]-=1;C[idx[bb],idx[a]]-=1
        if s1>s2:W[a]+=1;L[bb]+=1
        elif s2>s1:W[bb]+=1;L[a]+=1
    for t in teams:b[idx[t]]=1+(W[t]-L[t])/2
    try: r=np.linalg.solve(C,b)
    except np.linalg.LinAlgError: r=np.linalg.lstsq(C,b,rcond=None)[0]
    return {teams[i]:float(r[i]) for i in range(n)}

def build(compId,label,ongoing,path,colmap,divpath):
    M=json.load(open(path))['matches']
    names={}
    for m in M:
        for k in('1','2'):
            if m.get('team%sId'%k):names[m['team%sId'%k]]=m.get('team'+k)
    BYE={t for t,n in names.items() if (n or '').strip().lower()=='bye'}
    merged,pidx=periods_of(M)
    nP=len(merged)
    plabel=lambda i:(('Current' if ongoing else 'Final') if i==nP-1 else 'Phase %d'%(i+1))
    # pools per period
    periodMatches=defaultdict(list)
    for m in M: periodMatches[pidx((m.get('startTime')or'')[:10])].append(m)
    poolsByPeriod=[]      # list over periods of list of frozenset
    teamPeriodPool={}     # (team,pi)->pool index
    for pi in range(nP):
        cs=sorted(comps(periodMatches[pi],BYE),key=lambda s:-len(s))
        poolsByPeriod.append(cs)
        for j,p in enumerate(cs):
            for t in p: teamPeriodPool[(t,pi)]=j
    # net height per (period,pool): HIGH if any outside-court match among pool's games else LOW
    poolNet=[{} for _ in range(nP)]
    for pi in range(nP):
        for j,p in enumerate(poolsByPeriod[pi]):
            hi=False
            for m in periodMatches[pi]:
                a,b=m.get('team1Id'),m.get('team2Id')
                if a in p and b in p and court_no(m.get('court'))>=5: hi=True;break
            poolNet[pi][j]='HIGH' if hi else 'LOW'
    # per-team net movement across periods (up: low->high at any point, down: high->low)
    netMove={};netMarks={}
    for t in [x for x in names if x not in BYE]:
        seq=[poolNet[pi].get(teamPeriodPool.get((t,pi))) for pi in range(nP)]
        seq=[x for x in seq if x]
        up=any(seq[i]=='LOW' and seq[i+1]=='HIGH' for i in range(len(seq)-1))
        down=any(seq[i]=='HIGH' and seq[i+1]=='LOW' for i in range(len(seq)-1))
        netMove[names[t]]={'up':up,'down':down}
        mk=[]
        for i in range(1,len(seq)):
            if seq[i-1]=='LOW' and seq[i]=='HIGH': mk.append('up')
            elif seq[i-1]=='HIGH' and seq[i]=='LOW': mk.append('down')
            else: mk.append('same')
        netMarks[names[t]]=mk
    # tag each scored game with net height (by its pool), collect for ladders
    hi_games=[];lo_games=[]
    gamerec=[]  # (a,b,s1,s2,dt,mid,net,period)
    for pi in range(nP):
        for m in periodMatches[pi]:
            a,b,s1,s2=m.get('team1Id'),m.get('team2Id'),m.get('t1')or 0,m.get('t2')or 0
            if not(a and b) or a in BYE or b in BYE or (s1==0 and s2==0): continue
            j=teamPeriodPool.get((a,pi))
            net=poolNet[pi].get(j,'LOW') if j is not None else 'LOW'
            gamerec.append((a,b,s1,s2,(m.get('startTime')or'')[:10],m['id'],net,pi))
            (hi_games if net=='HIGH' else lo_games).append((a,b,s1,s2))
    # opposition-weighted ladder per net segment
    def ladder(games):
        teams=sorted({t for g in games for t in (g[0],g[1])})
        rating=colley(games,teams)
        W=defaultdict(int);L=defaultdict(int);D=defaultdict(int);PF=defaultdict(int);PA=defaultdict(int)
        h2h=defaultdict(lambda:defaultdict(int));opp=defaultdict(lambda:defaultdict(lambda:[0,0]))
        for a,bb,s1,s2 in games:
            PF[a]+=s1;PA[a]+=s2;PF[bb]+=s2;PA[bb]+=s1
            if s1>s2:W[a]+=1;L[bb]+=1;h2h[a][bb]+=1;h2h[bb][a]-=1
            elif s2>s1:W[bb]+=1;L[a]+=1;h2h[bb][a]+=1;h2h[a][bb]-=1
            else:D[a]+=1;D[bb]+=1
            opp[a][bb][0]+=s1>s2;opp[a][bb][1]+=s2>s1;opp[bb][a][0]+=s2>s1;opp[bb][a][1]+=s1>s2
        import functools
        def comcmp(a,bb):
            sh=set(opp[a])&set(opp[bb])-{a,bb}
            da=sum(opp[a][o][0]-opp[a][o][1] for o in sh);db=sum(opp[bb][o][0]-opp[bb][o][1] for o in sh)
            return da-db
        def cmp(a,bb):
            if abs(rating[a]-rating[bb])>1e-6: return -1 if rating[a]>rating[bb] else 1
            if h2h[a][bb]!=0: return -1 if h2h[a][bb]>0 else 1
            c=comcmp(a,bb)
            if c: return -1 if c>0 else 1
            gd=(PF[a]-PA[a])-(PF[bb]-PA[bb]); return -1 if gd>0 else (1 if gd<0 else 0)
        order=sorted(teams,key=functools.cmp_to_key(cmp))
        return [{'rank':i+1,'team':names[t],'rating':round(rating[t],3),'P':W[t]+L[t]+D[t],'W':W[t],'L':L[t],'D':D[t],'PF':PF[t],'PA':PA[t],'GD':PF[t]-PA[t],'up':netMove.get(names[t],{}).get('up',False),'down':netMove.get(names[t],{}).get('down',False),'marks':netMarks.get(names[t],[])} for i,t in enumerate(order)]
    ladderHigh=ladder(hi_games); ladderLow=ladder(lo_games)
    hiRank={r['team']:r for r in ladderHigh}; loRank={r['team']:r for r in ladderLow}
    # overall record per team
    W=defaultdict(int);L=defaultdict(int);Dd=defaultdict(int);PF=defaultdict(int);PA=defaultdict(int)
    for a,bb,s1,s2,dt,mid,net,pi in gamerec:
        PF[a]+=s1;PA[a]+=s2;PF[bb]+=s2;PA[bb]+=s1
        if s1>s2:W[a]+=1;L[bb]+=1
        elif s2>s1:W[bb]+=1;L[a]+=1
        else:Dd[a]+=1;Dd[bb]+=1
    allteams=[t for t in names if t not in BYE and (W[t]+L[t]+Dd[t])>0]
    # current-grade labels (last period pools)
    cp=poolsByPeriod[nP-1]
    # colour label via finaldiv if available
    finaldiv={}
    if colmap and divpath:
        Dv=json.load(open(divpath))
        for r in Dv['roundDivisionTeams']:
            c=colmap.get(r['divisionId'])
            for t in (r['team1Id'],r['team2Id']):
                if t and c: finaldiv[t]=c
    # order current pools by avg rating (use whichever net ladder the team sits in that period)
    def teamrate(t):
        return (hiRank[names[t]]['rating'] if names[t] in hiRank else None) if poolNet[nP-1].get(teamPeriodPool.get((t,nP-1)))=='HIGH' else (loRank[names[t]]['rating'] if names[t] in loRank else None)
    poolavg={}
    for j,p in enumerate(cp):
        rs=[teamrate(t) for t in p if teamrate(t) is not None]
        poolavg[j]=sum(rs)/len(rs) if rs else -9
    # strength order = full-net grades first (strongest within), then lowered-net grades
    order=sorted(range(len(cp)),key=lambda j:(0 if poolNet[nP-1][j]=='HIGH' else 1, -poolavg[j]))
    gradeLabel={}
    for rank,j in enumerate(order):
        if finaldiv:
            cc=defaultdict(int)
            for t in cp[j]: cc[finaldiv.get(t,'?')]+=1
            gradeLabel[j]=max(cc,key=cc.get)
        else:
            gradeLabel[j]='Grade %d'%(rank+1)
    # within-pool ladder for a given period+pool
    def poolLadder(pi,p):
        pm=[g for g in gamerec if g[7]==pi and g[0] in p and g[1] in p]
        tab=defaultdict(lambda:{'P':0,'W':0,'L':0,'D':0,'PF':0,'PA':0})
        for a,bb,s1,s2,dt,mid,net,_ in pm:
            for tt,sf,sa in ((a,s1,s2),(bb,s2,s1)):
                r=tab[tt];r['P']+=1;r['PF']+=sf;r['PA']+=sa;r['W']+=sf>sa;r['L']+=sf<sa;r['D']+=sf==sa
        for t in p:
            if names[t] not in {x['team'] for x in [{'team':names[q]} for q in tab]}: pass
        lad=[{'team':names[t],**v} for t,v in sorted(tab.items(),key=lambda kv:(-kv[1]['W'],-(kv[1]['PF']-kv[1]['PA'])))]
        for t in p:
            if names[t] not in {x['team'] for x in lad}: lad.append({'team':names[t],'P':0,'W':0,'L':0,'D':0,'PF':0,'PA':0})
        return lad
    # current grades view
    gradesView=[]
    for j in order:
        gradesView.append({'label':gradeLabel[j],'net':poolNet[nP-1][j],'ladder':poolLadder(nP-1,cp[j])})
    # periods view — pools ordered strongest-first (by avg overall rating), labelled to match Flow
    _allg=[(a,b,s1,s2) for (a,b,s1,s2,dt,mid,net,pi) in gamerec]
    _rAll=colley(_allg,sorted({t for g in _allg for t in g[:2]}))
    periodsView=[]
    for pi in range(nP):
        pools_s=sorted(range(len(poolsByPeriod[pi])),key=lambda j:-(sum(_rAll.get(t,0) for t in poolsByPeriod[pi][j])/max(1,len([x for x in poolsByPeriod[pi][j] if x not in BYE]))))
        pools=[]
        for rank,j in enumerate(pools_s):
            lab = gradeLabel[j] if pi==nP-1 else 'Pool %d'%(rank+1)
            pools.append({'label':lab,'net':poolNet[pi][j],'ladder':poolLadder(pi,poolsByPeriod[pi][j])})
        periodsView.append({'label':plabel(pi),'dateFrom':merged[pi][0] if pi<len(merged) else '','dateTo':merged[pi][1] if pi<len(merged) else '','pools':pools})
    # per-team
    teamsOut={}
    # games per team (chronological) with net + period label
    tg=defaultdict(list)
    for a,bb,s1,s2,dt,mid,net,pi in gamerec:
        tg[a].append({'date':dt,'opp':names[bb],'for':s1,'against':s2,'res':'W' if s1>s2 else('L' if s2>s1 else 'D'),'mid':mid,'net':net,'period':plabel(pi)})
        tg[bb].append({'date':dt,'opp':names[a],'for':s2,'against':s1,'res':'W' if s2>s1 else('L' if s1>s2 else 'D'),'mid':mid,'net':net,'period':plabel(pi)})
    for t in tg: tg[t].sort(key=lambda g:g['date'])
    # journey per team: per period pool label + net + record
    for t in allteams:
        jr=[]
        for pi in range(nP):
            j=teamPeriodPool.get((t,pi))
            if j is None: continue
            lab = gradeLabel[j] if pi==nP-1 else 'Pool %d'%(j+1)
            gs=[g for g in tg[t] if g['period']==plabel(pi)]
            w=sum(g['res']=='W' for g in gs);l=sum(g['res']=='L' for g in gs);d=sum(g['res']=='D' for g in gs)
            jr.append({'period':plabel(pi),'pool':lab,'net':poolNet[pi][j],'W':w,'L':l,'D':d})
        cj=teamPeriodPool.get((t,nP-1))
        teamsOut[names[t]]={'currentGrade':(gradeLabel[cj] if cj is not None else '—'),
            'currentNet':(poolNet[nP-1][cj] if cj is not None else None),
            'highRank':hiRank[names[t]]['rank'] if names[t] in hiRank else None,'highRating':hiRank[names[t]]['rating'] if names[t] in hiRank else None,
            'lowRank':loRank[names[t]]['rank'] if names[t] in loRank else None,'lowRating':loRank[names[t]]['rating'] if names[t] in loRank else None,
            'W':W[t],'L':L[t],'D':Dd[t],'PF':PF[t],'PA':PA[t],'journey':jr,'games':tg[t]}
    # FLOW (sankey-style): nodes per period ordered by strength, per-team path, grade colour
    allg2=[(a,b,s1,s2) for (a,b,s1,s2,dt,mid,net,pi) in gamerec]
    ratingAll=colley(allg2,sorted({t for g in allg2 for t in g[:2]}))
    nodeId={};flowCols=[]
    for pi in range(nP):
        pools=poolsByPeriod[pi]
        ordered=sorted(range(len(pools)),key=lambda j:-(sum(ratingAll.get(t,0) for t in pools[j])/max(1,len([x for x in pools[j] if x not in BYE]))))
        nodes=[]
        for rank,j in enumerate(ordered):
            nid='p%dn%d'%(pi,rank);nodeId[(pi,j)]=nid
            lab=gradeLabel[j] if pi==nP-1 else str(rank+1)
            lad=poolLadder(pi,pools[j]); rankpos={row['team']:ri for ri,row in enumerate(lad)}
            tm=sorted([names[t] for t in pools[j] if t not in BYE], key=lambda nm: rankpos.get(nm,999))
            nodes.append({'id':nid,'label':lab,'net':poolNet[pi][j],'count':len(tm),'teams':tm})
        flowCols.append({'period':plabel(pi),'nodes':nodes})
    paths=[]
    for t in allteams:
        seq=[nodeId.get((pi,teamPeriodPool.get((t,pi)))) for pi in range(nP)]
        paths.append({'team':names[t],'grade':teamsOut[names[t]]['currentGrade'],'net':teamsOut[names[t]]['currentNet'],'nodes':seq})
    flow={'columns':flowCols,'paths':paths}
    # per-quarter
    pq={}
    for m in M:
        ps=m.get('periods') or []
        if ps:
            cum=[(p.get('t1')or 0,p.get('t2')or 0) for p in ps];d=[];pa=pb=0
            for a,bbb in cum: d.append((a-pa,bbb-pb));pa,pb=a,bbb
            pq[m['id']]={'t1':m.get('team1'),'delta':d}
    return dict(compId=compId,label=label,ongoing=ongoing,colourNamed=bool(colmap),
                periodLabels=[plabel(i) for i in range(nP)],
                ladders={'HIGH':ladderHigh,'LOW':ladderLow},
                gradesView=gradesView,periodsView=periodsView,teams=teamsOut,periods=pq,flow=flow)
