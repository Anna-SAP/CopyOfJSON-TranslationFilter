import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ClipboardIcon from './components/icons/ClipboardIcon';
import CheckIcon from './components/icons/CheckIcon';
import { TranslationObject } from './types';

type Status = 'idle' | 'loading' | 'filtering' | 'ready' | 'error' | 'copying';

const workerCode = `
  let allTranslations = [];
  let primaryFilteredTranslations = []; 
  let finalFilteredTranslations = []; 
  let currentRefineQuery = '';
  let detectedKeys = []; 

  const PAGE_SIZE = 50;

  const generatePage = (page, data, view, selectedLanguages) => {
      const start = page * PAGE_SIZE;
      const end = start + PAGE_SIZE;
      const pageData = data.slice(start, end);
      const hasMore = end < data.length;

      let resultData = pageData;

      if (view === 'subset' && Array.isArray(selectedLanguages)) {
         resultData = pageData.map(item => {
            const newItem = { key: item.key };
            selectedLanguages.forEach(lang => {
               if (item[lang] !== undefined) {
                 newItem[lang] = item[lang];
               }
            });
            return newItem;
         });
      }

      return { results: resultData, hasMore };
  };

  const applyRefine = () => {
     if (!currentRefineQuery) {
         finalFilteredTranslations = primaryFilteredTranslations;
     } else {
         const lowerQuery = currentRefineQuery.toLowerCase();
         finalFilteredTranslations = primaryFilteredTranslations.filter(item => 
             JSON.stringify(item).toLowerCase().includes(lowerQuery)
         );
     }
  };

  self.onmessage = (event) => {
    const { type, payload, jobId } = event.data;

    try {
      switch (type) {
        case 'load':
          const data = JSON.parse(payload);
          if (!Array.isArray(data)) throw new Error("JSON is not an array.");
          
          allTranslations = data;
          primaryFilteredTranslations = allTranslations;
          finalFilteredTranslations = allTranslations;
          
          detectedKeys = data.length > 0 
            ? Object.keys(data[0]).filter(k => k !== 'key')
            : [];

          self.postMessage({ 
            type: 'loaded', 
            total: allTranslations.length, 
            count: finalFilteredTranslations.length, 
            languages: detectedKeys,
            jobId 
          });
          break;

        case 'filter':
          const { 
            keySearch,
            sourceSearch, 
            targetSearch, 
            targetNegativeSearch,
            matchKeyWholeWord,
            matchSourceWholeWord, 
            matchTargetWholeWord,
            matchKeyCase,
            matchSourceCase,
            matchTargetCase,
            matchTargetNegativeCase,
            activeTargetLanguages = []
          } = payload;
          
          currentRefineQuery = ''; 
          
          if (!allTranslations.length) {
              primaryFilteredTranslations = [];
          } else {
              const sKey = matchKeyCase ? keySearch.trim() : keySearch.trim().toLowerCase();
              const sSrc = matchSourceCase ? sourceSearch.trim() : sourceSearch.trim().toLowerCase();
              const sTarPos = matchTargetCase ? targetSearch.trim() : targetSearch.trim().toLowerCase();
              const sTarNeg = matchTargetNegativeCase ? targetNegativeSearch.trim() : targetNegativeSearch.trim().toLowerCase();

              const targetLangsToCheck = activeTargetLanguages.filter(l => l !== 'en-US');

              primaryFilteredTranslations = allTranslations.filter(item => {
                  // 1. Key
                  if (sKey !== '') {
                      const val = String(item.key || '');
                      const target = matchKeyCase ? val : val.toLowerCase();
                      if (matchKeyWholeWord ? target !== sKey : !target.includes(sKey)) return false;
                  }

                  // 2. Source
                  if (sSrc !== '') {
                      const val = String(item['en-US'] || '');
                      const target = matchSourceCase ? val : val.toLowerCase();
                      if (matchSourceWholeWord ? target !== sSrc : !target.includes(sSrc)) return false;
                  }

                  // 3. Target
                  const hasPos = sTarPos !== '';
                  const hasNeg = sTarNeg !== '';

                  if (hasPos || hasNeg) {
                      let foundPos = !hasPos;
                      let foundNeg = false;

                      for (const lang of targetLangsToCheck) {
                          const val = String(item[lang] || '');
                          if (!val) continue;
                          const targetVal = (matchTargetCase || matchTargetNegativeCase) ? val : val.toLowerCase();

                          if (hasPos && !foundPos) {
                              const posCompare = matchTargetCase ? sTarPos : sTarPos.toLowerCase();
                              if (matchTargetWholeWord ? targetVal === posCompare : targetVal.includes(posCompare)) {
                                  foundPos = true;
                              }
                          }

                          if (hasNeg) {
                              const negCompare = matchTargetNegativeCase ? sTarNeg : sTarNeg.toLowerCase();
                              if (targetVal.includes(negCompare)) {
                                  foundNeg = true;
                                  break;
                              }
                          }
                      }
                      if (!foundPos || foundNeg) return false;
                  }

                  return true;
              });
          }
          applyRefine();
          self.postMessage({ type: 'filtered', count: finalFilteredTranslations.length, jobId });
          break;

        case 'refine':
          currentRefineQuery = payload.query;
          applyRefine();
          self.postMessage({ type: 'filtered', count: finalFilteredTranslations.length, jobId });
          break;

        case 'get-page':
          const { page, view, selectedLanguages } = payload;
          const { results, hasMore } = generatePage(page, finalFilteredTranslations, view, selectedLanguages);
          self.postMessage({ type: 'page-data', view, results, hasMore, page, jobId });
          break;
        
        case 'get-full-json':
          const { view: v, selectedLanguages: sl } = payload;
          let out = finalFilteredTranslations;
          if (v === 'subset' && Array.isArray(sl)) {
             out = finalFilteredTranslations.map(item => {
                const n = { key: item.key };
                sl.forEach(l => { if (item[l] !== undefined) n[l] = item[l]; });
                return n;
             });
          }
          self.postMessage({ type: 'full-json-result', fullJson: JSON.stringify(out, null, 2), view: v, jobId });
          break;

        case 'get-translated-json':
          const { selectedLanguages: tl } = payload;
          const trans = finalFilteredTranslations.reduce((acc, item) => {
              const n = { key: item.key };
              let valid = false;
              if (Array.isArray(tl)) {
                  tl.forEach(l => { if (item[l] !== undefined) { n[l] = item[l]; if (l !== 'en-US') valid = true; } });
              }
              if (valid) acc.push(n);
              return acc;
          }, []);
          self.postMessage({ type: 'translated-json-result', translatedJson: JSON.stringify(trans, null, 2), jobId });
          break;

        case 'get-all-keys':
          const keys = finalFilteredTranslations.map(item => item.key).filter(Boolean).join('\\n');
          self.postMessage({ type: 'all-keys-result', keysList: keys, jobId });
          break;
      }
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message, jobId });
    }
  };
`;

const App: React.FC = () => {
  const [keySearch, setKeySearch] = useState('');
  const [sourceSearch, setSourceSearch] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [targetNegativeSearch, setTargetNegativeSearch] = useState('');
  const [matchKeyWholeWord, setMatchKeyWholeWord] = useState(false);
  const [matchSourceWholeWord, setMatchSourceWholeWord] = useState(false);
  const [matchTargetWholeWord, setMatchTargetWholeWord] = useState(false);
  const [matchKeyCase, setMatchKeyCase] = useState(false);
  const [matchSourceCase, setMatchSourceCase] = useState(false);
  const [matchTargetCase, setMatchTargetCase] = useState(false);
  const [matchTargetNegativeCase, setMatchTargetNegativeCase] = useState(false);
  const [refineQuery, setRefineQuery] = useState('');

  const [fileName, setFileName] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [availableLanguages, setAvailableLanguages] = useState<string[]>([]);
  const [selectedLanguages, setSelectedLanguages] = useState<Set<string>>(new Set());
  const selectedLanguagesRef = useRef<Set<string>>(new Set());

  const [status, setStatus] = useState<Status>('idle');
  const [totalCount, setTotalCount] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);

  const [mainResults, setMainResults] = useState<TranslationObject[]>([]);
  const [mainHasMore, setMainHasMore] = useState(false);
  const [mainCurrentPage, setMainCurrentPage] = useState(0);
  const [isMainCopied, setIsMainCopied] = useState(false);

  const [subsetResults, setSubsetResults] = useState<TranslationObject[]>([]);
  const [subsetHasMore, setSubsetHasMore] = useState(false);
  const [subsetCurrentPage, setSubsetCurrentPage] = useState(0);
  const [isSubsetCopied, setIsSubsetCopied] = useState(false);
  const [isSubsetKeysCopied, setIsSubsetKeysCopied] = useState(false);
  const [isTranslatedCopied, setIsTranslatedCopied] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const mainPreRef = useRef<HTMLDivElement | null>(null);
  const subsetPreRef = useRef<HTMLDivElement | null>(null);
  const jobIdRef = useRef<number>(0);

  useEffect(() => { selectedLanguagesRef.current = selectedLanguages; }, [selectedLanguages]);

  const getDisplayName = useMemo(() => {
    let langNames: Intl.DisplayNames | undefined;
    try { langNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (e) {}
    return (code: string) => {
        if (!langNames) return code;
        try { return `${langNames.of(code)} (${code})`; } catch (e) { return code; }
    };
  }, []);

  const sortedLanguages = useMemo(() => {
    return [...availableLanguages].sort((a, b) => {
      if (a === 'en-US') return -1;
      if (b === 'en-US') return 1;
      return a.localeCompare(b);
    });
  }, [availableLanguages]);

  const requestPage = useCallback((page: number, view: 'main' | 'subset', langsOverride?: string[]) => {
      const langs = langsOverride || Array.from(selectedLanguagesRef.current);
      workerRef.current?.postMessage({
          type: 'get-page',
          jobId: jobIdRef.current,
          payload: { page, view, selectedLanguages: langs }
      });
  }, []);

  useEffect(() => {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);
    workerRef.current = worker;

    worker.onmessage = (event) => {
      const { type, jobId, results, count, total, hasMore, page, message, fullJson, translatedJson, languages, view, keysList } = event.data;
      if (jobId !== undefined && jobId !== jobIdRef.current) return;

      switch (type) {
        case 'loaded':
          setAvailableLanguages(languages || []);
          setSelectedLanguages(new Set(languages || []));
          setTotalCount(total);
          setFilteredCount(count);
          requestPage(0, 'main');
          requestPage(0, 'subset', languages || []);
          setStatus('ready');
          break;
        case 'filtered':
          setFilteredCount(count);
          setMainResults([]);
          setSubsetResults([]);
          requestPage(0, 'main');
          requestPage(0, 'subset');
          setStatus('ready');
          break;
        case 'page-data':
          if (view === 'main') {
             setMainResults(prev => (page === 0 ? results : [...prev, ...results]));
             setMainHasMore(hasMore);
             setMainCurrentPage(page);
          } else {
             setSubsetResults(prev => (page === 0 ? results : [...prev, ...results]));
             setSubsetHasMore(hasMore);
             setSubsetCurrentPage(page);
          }
          break;
        case 'full-json-result':
          navigator.clipboard.writeText(fullJson).then(() => {
            if (view === 'main') setIsMainCopied(true); else setIsSubsetCopied(true);
            setTimeout(() => { setIsMainCopied(false); setIsSubsetCopied(false); }, 2000);
            setStatus('ready');
          });
          break;
        case 'translated-json-result':
          navigator.clipboard.writeText(translatedJson).then(() => {
              setIsTranslatedCopied(true);
              setTimeout(() => setIsTranslatedCopied(false), 2000);
              setStatus('ready');
          });
          break;
        case 'all-keys-result':
          navigator.clipboard.writeText(keysList).then(() => {
              setIsSubsetKeysCopied(true);
              setTimeout(() => setIsSubsetKeysCopied(false), 2000);
              setStatus('ready');
          });
          break;
        case 'error':
          setError(message);
          setStatus('error');
          break;
      }
    };
    
    worker.onerror = (err) => {
        console.error("Worker error:", err);
        setError("An internal error occurred in the background worker.");
        setStatus('error');
    };

    return () => { worker.terminate(); URL.revokeObjectURL(workerUrl); };
  }, [requestPage]);

  const handleApplyFilters = useCallback(() => {
    if (status === 'loading') return;
    const newJobId = Date.now();
    jobIdRef.current = newJobId;
    setStatus('filtering');
    workerRef.current?.postMessage({
        type: 'filter',
        jobId: newJobId,
        payload: { 
          keySearch,
          sourceSearch, 
          targetSearch, 
          targetNegativeSearch,
          matchKeyWholeWord,
          matchSourceWholeWord, 
          matchTargetWholeWord,
          matchKeyCase,
          matchSourceCase,
          matchTargetCase,
          matchTargetNegativeCase,
          activeTargetLanguages: Array.from(selectedLanguages) 
        },
    });
  }, [status, keySearch, sourceSearch, targetSearch, targetNegativeSearch, matchKeyWholeWord, matchSourceWholeWord, matchTargetWholeWord, matchKeyCase, matchSourceCase, matchTargetCase, matchTargetNegativeCase, selectedLanguages]);

  const handleRefineSearch = (query: string) => {
    setRefineQuery(query);
    if (status !== 'ready') return;
    workerRef.current?.postMessage({ type: 'refine', jobId: jobIdRef.current, payload: { query } });
  };

  const handleLanguageChange = (lang: string) => {
      const newSet = new Set(selectedLanguages);
      if (newSet.has(lang)) newSet.delete(lang); else newSet.add(lang);
      setSelectedLanguages(newSet);
  };

  const processFile = (file: File) => {
    setFileName(file.name);
    setError(null);
    setStatus('loading');
    
    const newJobId = Date.now();
    jobIdRef.current = newJobId;

    const reader = new FileReader();
    reader.onload = (e) => workerRef.current?.postMessage({ type: 'load', jobId: newJobId, payload: e.target?.result });
    reader.onerror = () => {
        setError("Failed to read file");
        setStatus('error');
    };
    reader.readAsText(file);
  };

  const handleCopy = (view: 'main' | 'subset') => {
    if (status !== 'ready') return;
    setStatus('copying');
    workerRef.current?.postMessage({
      type: 'get-full-json',
      jobId: jobIdRef.current,
      payload: { view, selectedLanguages: Array.from(selectedLanguages) }
    });
  };

  const handleCopyKeys = () => {
    if (status !== 'ready') return;
    setStatus('copying');
    workerRef.current?.postMessage({
      type: 'get-all-keys',
      jobId: jobIdRef.current
    });
  };

  const handleCopyTranslated = () => {
    if (status !== 'ready') return;
    setStatus('copying');
    workerRef.current?.postMessage({
      type: 'get-translated-json',
      jobId: jobIdRef.current,
      payload: { selectedLanguages: Array.from(selectedLanguages) }
    });
  };

  const renderContent = (view: 'main' | 'subset') => {
    if (status === 'loading') return <div className="h-full flex items-center justify-center text-gray-500">Processing...</div>;
    if (status === 'idle') return <div className="h-full flex items-center justify-center text-gray-500">Upload a JSON file to start</div>;
    const results = view === 'main' ? mainResults : subsetResults;
    if (filteredCount === 0 && status !== 'error') return <div className="p-4 font-mono text-gray-500">[]</div>;
    return (
        <div className="font-mono text-xs sm:text-sm">
            <div className="text-gray-500">{'['}</div>
            {results.map((item, index) => (
                <div key={index} className="flex group hover:bg-gray-700/30 rounded-sm">
                    <div className="select-none text-gray-600 w-10 text-right pr-3 flex-shrink-0 opacity-50 py-0.5" aria-hidden="true">{index + 1}</div>
                    <div className="flex-grow min-w-0"><pre className="whitespace-pre-wrap break-all">{JSON.stringify(item, null, 2)}{index < filteredCount - 1 ? ',' : ''}</pre></div>
                </div>
            ))}
            <div className="text-gray-500">{']'}</div>
        </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-200 font-sans p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-cyan-400">JSON Translation Filter</h1>
          <p className="text-gray-400 mt-2">Precision filtering for multilingual localizable strings.</p>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-8">
          <div className="space-y-6">
             <div className="bg-gray-800 p-6 rounded-lg shadow-xl space-y-6 border border-gray-700">
                <div>
                    <h2 className="text-xl font-semibold text-white mb-4 border-b border-gray-700 pb-2">Configuration</h2>
                    <div onDragOver={(e)=>{e.preventDefault();setIsDragging(true)}} onDragLeave={()=>setIsDragging(false)} onDrop={(e)=>{e.preventDefault();setIsDragging(false);const f=e.dataTransfer.files[0];if(f)processFile(f)}}
                        className={`flex justify-center px-6 pt-5 pb-6 border-2 border-dashed rounded-md transition-all cursor-pointer ${isDragging ? 'border-cyan-400 bg-cyan-400/5' : 'border-gray-600 hover:border-gray-500'}`}>
                        <div className="space-y-1 text-center">
                            <svg className="mx-auto h-10 w-10 text-gray-500" stroke="currentColor" fill="none" viewBox="0 0 48 48"><path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            <div className="flex text-sm text-gray-400 justify-center">
                                <label className="relative cursor-pointer text-cyan-400 hover:text-cyan-300 font-medium">
                                    <span>Upload a file</span>
                                    <input type="file" className="sr-only" accept=".json" onChange={(e)=>e.target.files?.[0] && processFile(e.target.files[0])}/>
                                </label>
                                <span className="pl-1">or drag & drop</span>
                            </div>
                        </div>
                    </div>
                    {fileName && (
                      <p className="text-xs text-cyan-400 mt-2 font-mono">
                        Current: {fileName}
                        {status === 'ready' && totalCount > 0 && (
                          <span className="ml-2 text-yellow-400 font-bold">({totalCount})</span>
                        )}
                      </p>
                    )}
                    {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
                </div>

                <div className="space-y-5">
                    <section>
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-2">Search by Key</label>
                        <input type="text" value={keySearch} onChange={(e)=>setKeySearch(e.target.value)} placeholder="e.g. Navigation.Title" className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:ring-1 focus:ring-cyan-500 outline-none"/>
                        <div className="flex gap-4 mt-2">
                            <label className="flex items-center text-xs text-gray-400 cursor-pointer"><input type="checkbox" checked={matchKeyWholeWord} onChange={(e)=>setMatchKeyWholeWord(e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/> Match whole</label>
                            <label className="flex items-center text-xs text-gray-400 cursor-pointer"><input type="checkbox" checked={matchKeyCase} onChange={(e)=>setMatchKeyCase(e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/> Match case</label>
                        </div>
                    </section>

                    <section>
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-2">Source (en-US)</label>
                        <input type="text" value={sourceSearch} onChange={(e)=>setSourceSearch(e.target.value)} placeholder="Search English content..." className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:ring-1 focus:ring-cyan-500 outline-none"/>
                        <div className="flex gap-4 mt-2">
                            <label className="flex items-center text-xs text-gray-400 cursor-pointer"><input type="checkbox" checked={matchSourceWholeWord} onChange={(e)=>setMatchSourceWholeWord(e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/> Match whole</label>
                            <label className="flex items-center text-xs text-gray-400 cursor-pointer"><input type="checkbox" checked={matchSourceCase} onChange={(e)=>setMatchSourceCase(e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/> Match case</label>
                        </div>
                    </section>

                    <section className="bg-gray-700/20 p-3 rounded border border-gray-700/50">
                        <label className="text-xs font-bold text-cyan-400 uppercase tracking-wider block mb-2">Target Filter</label>
                        <input type="text" value={targetSearch} onChange={(e)=>setTargetSearch(e.target.value)} placeholder="Positive keyword..." className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:ring-1 focus:ring-cyan-500 outline-none mb-2"/>
                        <input type="text" value={targetNegativeSearch} onChange={(e)=>setTargetNegativeSearch(e.target.value)} placeholder="Negative keyword (Exclude)..." className="w-full bg-gray-900 border border-red-900/50 rounded px-3 py-2 text-sm focus:ring-1 focus:ring-red-500 outline-none"/>
                        
                        <div className="grid grid-cols-2 gap-y-2 mt-3">
                            <label className="flex items-center text-xs text-gray-400 cursor-pointer"><input type="checkbox" checked={matchTargetWholeWord} onChange={(e)=>setMatchTargetWholeWord(e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/> Match whole</label>
                            <label className="flex items-center text-xs text-gray-400 cursor-pointer"><input type="checkbox" checked={matchTargetCase} onChange={(e)=>setMatchTargetCase(e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/> Match case (Pos)</label>
                            <label className="flex items-center text-xs text-gray-400 cursor-pointer col-span-2"><input type="checkbox" checked={matchTargetNegativeCase} onChange={(e)=>setMatchTargetNegativeCase(e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-red-500"/> Match case (Neg)</label>
                        </div>
                    </section>

                    <section>
                        <div className="flex justify-between items-center mb-2">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Languages</label>
                            <div className="flex gap-2">
                                <button onClick={()=>setSelectedLanguages(new Set(availableLanguages))} className="text-[10px] text-cyan-400 hover:underline">All</button>
                                <button onClick={()=>setSelectedLanguages(new Set())} className="text-[10px] text-cyan-400 hover:underline">None</button>
                            </div>
                        </div>
                        <div className="max-h-48 overflow-y-auto bg-gray-900/50 border border-gray-700 rounded p-2 space-y-1 custom-scrollbar">
                            {sortedLanguages.map(l => (
                                <label key={l} className="flex items-center text-xs text-gray-300 cursor-pointer hover:bg-gray-700/30 p-1 rounded">
                                    <input type="checkbox" checked={selectedLanguages.has(l)} onChange={()=>handleLanguageChange(l)} className="mr-2 h-3.5 w-3.5 accent-cyan-500"/>
                                    {getDisplayName(l)}
                                </label>
                            ))}
                        </div>
                    </section>
                </div>

                <button onClick={handleApplyFilters} disabled={status === 'loading' || status === 'filtering' || status === 'copying'}
                    className="w-full py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 text-white font-bold rounded shadow-lg transition-all active:scale-[0.98]">
                    {status === 'filtering' ? 'Filtering...' : 'Apply Filters'}
                </button>
             </div>
          </div>

          <div className="space-y-8 min-w-0">
            <div className="bg-gray-800 rounded-lg shadow-2xl flex flex-col h-[400px] border border-gray-700">
                <div className="flex justify-between items-center p-4 border-b border-gray-700">
                  <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Global Results ({filteredCount})</h2>
                  <button onClick={()=>handleCopy('main')} disabled={status!=='ready'||mainResults.length===0} className={`px-3 py-1 text-xs font-bold rounded flex items-center transition-all ${isMainCopied?'bg-green-600':'bg-gray-700 hover:bg-gray-600'}`}>
                    {isMainCopied ? <><CheckIcon className="h-3 w-3 mr-1"/> Copied</> : <><ClipboardIcon className="h-3 w-3 mr-1"/> Copy JSON</>}
                  </button>
                </div>
                <div className="flex-grow overflow-auto p-4 custom-scrollbar bg-gray-900/30" ref={mainPreRef} onScroll={() => (mainPreRef.current?.scrollHeight! - mainPreRef.current?.scrollTop! < 600) && mainHasMore && requestPage(mainCurrentPage+1, 'main')}>
                    {renderContent('main')}
                </div>
            </div>

            <div className="bg-gray-800 rounded-lg shadow-2xl flex flex-col h-[500px] border border-gray-700">
                <div className="p-4 border-b border-gray-700 space-y-3">
                  <div className="flex justify-between items-center">
                    <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Filtered Subset ({filteredCount})</h2>
                    <div className="flex gap-2">
                        <button onClick={handleCopyKeys} className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-[10px] font-bold rounded uppercase">Keys</button>
                        <button onClick={handleCopyTranslated} className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-[10px] font-bold rounded uppercase">w/ Trans</button>
                        <button onClick={()=>handleCopy('subset')} className={`px-3 py-1 text-[10px] font-bold rounded uppercase transition-all ${isSubsetCopied?'bg-green-600':'bg-cyan-600 hover:bg-cyan-500'}`}>JSON</button>
                    </div>
                  </div>
                  <input type="text" placeholder="Quick refine (Refine logic)..." value={refineQuery} onChange={(e)=>handleRefineSearch(e.target.value)} className="w-full bg-gray-900/50 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-300 outline-none focus:border-cyan-500/50"/>
                </div>
                <div className="flex-grow overflow-auto p-4 custom-scrollbar bg-gray-900/30" ref={subsetPreRef} onScroll={() => (subsetPreRef.current?.scrollHeight! - subsetPreRef.current?.scrollTop! < 800) && subsetHasMore && requestPage(subsetCurrentPage+1, 'subset')}>
                    {renderContent('subset')}
                </div>
            </div>
          </div>
        </main>
      </div>
       <style>{`
          .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
          .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
          .custom-scrollbar::-webkit-scrollbar-thumb { background: #374151; border-radius: 10px; }
          .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #4b5563; }
      `}</style>
    </div>
  );
};

export default App;