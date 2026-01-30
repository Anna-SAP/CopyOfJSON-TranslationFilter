
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ClipboardIcon from './components/icons/ClipboardIcon';
import CheckIcon from './components/icons/CheckIcon';
import { TranslationObject } from './types';

type Status = 'idle' | 'loading' | 'filtering' | 'ready' | 'error' | 'copying';

interface SourceFilterItem {
  id: string;
  text: string;
  whole: boolean;
  caseSens: boolean;
  isRegex: boolean;
}

interface TargetFilterItem {
  id: string;
  posText: string;
  negText: string;
  whole: boolean;
  posCaseSens: boolean;
  posIsRegex: boolean;
  negCaseSens: boolean;
  negIsRegex: boolean;
}

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
            isKeyRegex,
            keyNegativeSearch,
            isKeyNegativeRegex,
            sourceFilters = [], 
            sourceLogic = 'AND',
            targetFilters = [],
            targetLogic = 'AND',
            matchKeyWholeWord,
            matchKeyCase,
            matchKeyNegativeCase,
            activeTargetLanguages = []
          } = payload;
          
          currentRefineQuery = ''; 
          
          if (!allTranslations.length) {
              primaryFilteredTranslations = [];
          } else {
              // --- PRE-COMPILE REGEX PATTERNS ---
              
              // Positive Key Regex
              let keyRgx = null;
              if (isKeyRegex && keySearch.trim()) {
                  try { keyRgx = new RegExp(keySearch.trim(), matchKeyCase ? '' : 'i'); } catch(e) {}
              }

              // Negative Key Regex
              let keyNegRgx = null;
              if (isKeyNegativeRegex && keyNegativeSearch && keyNegativeSearch.trim()) {
                  try { keyNegRgx = new RegExp(keyNegativeSearch.trim(), matchKeyNegativeCase ? '' : 'i'); } catch(e) {}
              }

              // --- PRE-PROCESS MULTI-KEY (POSITIVE) ---
              let keyList = [];
              let keySet = null;
              let useMultiKey = false;
              if (!isKeyRegex && keySearch && keySearch.trim() !== '') {
                  useMultiKey = true;
                  keyList = keySearch.split(/[\\n,\\s]+/).map(k => k.trim()).filter(k => k !== '');
                  if (!matchKeyCase) {
                      keyList = keyList.map(k => k.toLowerCase());
                  }
                  if (matchKeyWholeWord) {
                      keySet = new Set(keyList);
                  }
              }

              // --- PRE-PROCESS MULTI-KEY (NEGATIVE) ---
              let keyNegList = [];
              let keyNegSet = null;
              let useMultiNegKey = false;
              if (!isKeyNegativeRegex && keyNegativeSearch && keyNegativeSearch.trim() !== '') {
                  useMultiNegKey = true;
                  keyNegList = keyNegativeSearch.split(/[\\n,\\s]+/).map(k => k.trim()).filter(k => k !== '');
                  if (!matchKeyNegativeCase) {
                      keyNegList = keyNegList.map(k => k.toLowerCase());
                  }
                  if (matchKeyWholeWord) {
                      keyNegSet = new Set(keyNegList);
                  }
              }

              const preparedSourceFilters = sourceFilters
                  .filter(f => f.text && f.text.trim() !== '')
                  .map(f => {
                      if (f.isRegex) {
                          try {
                              return { ...f, tester: new RegExp(f.text, f.caseSens ? '' : 'i'), isValid: true };
                          } catch (e) {
                              return { ...f, isValid: false };
                          }
                      }
                      return f;
                  });

              const preparedTargetFilters = targetFilters.map(f => {
                  const p = { ...f, valid: true };
                  if (f.posIsRegex && f.posText && f.posText.trim()) {
                      try { p.posTester = new RegExp(f.posText, f.posCaseSens ? '' : 'i'); } catch(e) { p.valid = false; }
                  }
                  if (f.negIsRegex && f.negText && f.negText.trim()) {
                      try { p.negTester = new RegExp(f.negText, f.negCaseSens ? '' : 'i'); } catch(e) { p.valid = false; }
                  }
                  return p;
              });

              // --- END PRE-COMPILE ---

              const sKey = matchKeyCase ? keySearch.trim() : keySearch.trim().toLowerCase();

              const targetLangsToCheck = activeTargetLanguages.filter(l => l !== 'en-US');

              primaryFilteredTranslations = allTranslations.filter(item => {
                  const valKey = String(item.key || '');
                  
                  // 1. Positive Key Check
                  if (keySearch.trim() !== '') {
                      if (isKeyRegex) {
                          if (!keyRgx || !keyRgx.test(valKey)) return false;
                      } else if (useMultiKey) {
                          const target = matchKeyCase ? valKey : valKey.toLowerCase();
                          if (matchKeyWholeWord) {
                              if (!keySet.has(target)) return false;
                          } else {
                              let match = false;
                              for (let i = 0; i < keyList.length; i++) {
                                  if (target.includes(keyList[i])) {
                                      match = true;
                                      break;
                                  }
                              }
                              if (!match) return false;
                          }
                      } else {
                          const target = matchKeyCase ? valKey : valKey.toLowerCase();
                          if (matchKeyWholeWord ? target !== sKey : !target.includes(sKey)) return false;
                      }
                  }

                  // 2. Negative Key Check
                  if (keyNegativeSearch && keyNegativeSearch.trim() !== '') {
                       if (isKeyNegativeRegex) {
                          if (keyNegRgx && keyNegRgx.test(valKey)) return false;
                       } else if (useMultiNegKey) {
                          const target = matchKeyNegativeCase ? valKey : valKey.toLowerCase();
                          if (matchKeyWholeWord) {
                              if (keyNegSet.has(target)) return false;
                          } else {
                              for (let i = 0; i < keyNegList.length; i++) {
                                  if (target.includes(keyNegList[i])) return false;
                              }
                          }
                       }
                  }

                  // 3. Source (Dynamic Logic)
                  if (preparedSourceFilters.length > 0) {
                      const srcVal = String(item['en-US'] || '');
                      
                      const checkFilter = (filter) => {
                          if (filter.isRegex) {
                              return filter.isValid && filter.tester.test(srcVal);
                          }
                          const fText = filter.caseSens ? filter.text.trim() : filter.text.trim().toLowerCase();
                          const target = filter.caseSens ? srcVal : srcVal.toLowerCase();
                          if (filter.whole) {
                              return target === fText;
                          }
                          return target.includes(fText);
                      };

                      if (sourceLogic === 'OR') {
                          if (!preparedSourceFilters.some(checkFilter)) return false;
                      } else {
                          if (!preparedSourceFilters.every(checkFilter)) return false;
                      }
                  }

                  // 4. Target (Dynamic Logic)
                  if (preparedTargetFilters.length > 0) {
                      const checkTargetGroup = (filter) => {
                          if (!filter.valid) return false;
                          
                          const hasPos = filter.posText && filter.posText.trim() !== '';
                          const hasNeg = filter.negText && filter.negText.trim() !== '';
                          
                          if (!hasPos && !hasNeg) return true;

                          let foundPos = !hasPos; // If no pos requirement, we consider it met unless overridden by failure elsewhere? 
                                                  // Logic: "Is this item valid for this rule?" 
                                                  // If no Pos rule, any item is candidate.
                          let foundNeg = false;
                          
                          const sPos = filter.posCaseSens ? filter.posText.trim() : filter.posText.trim().toLowerCase();
                          const sNeg = filter.negCaseSens ? filter.negText.trim() : filter.negText.trim().toLowerCase();

                          for (const lang of targetLangsToCheck) {
                              const val = String(item[lang] || '');
                              if (!val) continue;

                              if (hasPos && !foundPos) {
                                  if (filter.posIsRegex) {
                                      if (filter.posTester && filter.posTester.test(val)) foundPos = true;
                                  } else {
                                      const tVal = filter.posCaseSens ? val : val.toLowerCase();
                                      if (filter.whole ? tVal === sPos : tVal.includes(sPos)) foundPos = true;
                                  }
                              }

                              if (hasNeg) {
                                  if (filter.negIsRegex) {
                                      if (filter.negTester && filter.negTester.test(val)) {
                                          foundNeg = true;
                                      }
                                  } else {
                                      const tVal = filter.negCaseSens ? val : val.toLowerCase();
                                      if (filter.whole ? tVal === sNeg : tVal.includes(sNeg)) {
                                          foundNeg = true;
                                      }
                                  }
                              }
                              
                              if (foundPos && foundNeg) break;
                          }

                          if (foundNeg) return false;
                          if (!foundPos) return false;
                          return true;
                      };

                      if (targetLogic === 'OR') {
                          if (!preparedTargetFilters.some(checkTargetGroup)) return false;
                      } else {
                          if (!preparedTargetFilters.every(checkTargetGroup)) return false;
                      }
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
  // Key Search State
  const [keySearch, setKeySearch] = useState('');
  const [keyNegativeSearch, setKeyNegativeSearch] = useState('');
  const [matchKeyWholeWord, setMatchKeyWholeWord] = useState(false);
  const [matchKeyCase, setMatchKeyCase] = useState(false);
  const [matchKeyNegativeCase, setMatchKeyNegativeCase] = useState(false);
  const [isKeyRegex, setIsKeyRegex] = useState(false);
  const [isKeyNegativeRegex, setIsKeyNegativeRegex] = useState(false);
  
  // Source Filter State
  const [sourceFilters, setSourceFilters] = useState<SourceFilterItem[]>([
    { id: 'initial', text: '', whole: false, caseSens: false, isRegex: false }
  ]);
  const [sourceLogic, setSourceLogic] = useState<'AND' | 'OR'>('AND');

  // Target Filter State
  const [targetFilters, setTargetFilters] = useState<TargetFilterItem[]>([
    { 
      id: 'initial', 
      posText: '', 
      negText: '', 
      whole: false, 
      posCaseSens: false, 
      posIsRegex: false, 
      negCaseSens: false, 
      negIsRegex: false 
    }
  ]);
  const [targetLogic, setTargetLogic] = useState<'AND' | 'OR'>('AND');

  // App State
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

  const keyCount = useMemo(() => {
    if (!keySearch || isKeyRegex) return 0;
    return keySearch.split(/[\n,\s]+/).filter(k => k.trim()).length;
  }, [keySearch, isKeyRegex]);
  
  const keyNegCount = useMemo(() => {
    if (!keyNegativeSearch || isKeyNegativeRegex) return 0;
    return keyNegativeSearch.split(/[\n,\s]+/).filter(k => k.trim()).length;
  }, [keyNegativeSearch, isKeyNegativeRegex]);

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
          isKeyRegex,
          keyNegativeSearch,
          isKeyNegativeRegex,
          sourceFilters: sourceFilters.map(({id, ...rest}) => rest),
          sourceLogic,
          targetFilters: targetFilters.map(({id, ...rest}) => rest),
          targetLogic,
          matchKeyWholeWord,
          matchKeyCase,
          matchKeyNegativeCase,
          activeTargetLanguages: Array.from(selectedLanguages) 
        },
    });
  }, [status, keySearch, isKeyRegex, keyNegativeSearch, isKeyNegativeRegex, sourceFilters, sourceLogic, targetFilters, targetLogic, matchKeyWholeWord, matchKeyCase, matchKeyNegativeCase, selectedLanguages]);

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

  // Source Filter Handlers
  const addSourceFilter = () => {
    setSourceFilters(prev => [...prev, { id: Date.now().toString(), text: '', whole: false, caseSens: false, isRegex: false }]);
  };

  const removeSourceFilter = (id: string) => {
    if (sourceFilters.length > 1) {
      setSourceFilters(prev => prev.filter(item => item.id !== id));
    } else {
        updateSourceFilter(id, 'text', '');
    }
  };
  
  const handleClearSourceFilters = () => {
    setSourceFilters([{ id: Date.now().toString(), text: '', whole: false, caseSens: false, isRegex: false }]);
    setSourceLogic('AND');
  };

  const updateSourceFilter = (id: string, field: keyof SourceFilterItem, value: any) => {
    setSourceFilters(prev => prev.map(item => item.id === id ? { ...item, [field]: value } : item));
  };

  // Target Filter Handlers
  const addTargetFilter = () => {
    setTargetFilters(prev => [...prev, { 
      id: Date.now().toString(), 
      posText: '', negText: '', 
      whole: false, 
      posCaseSens: false, posIsRegex: false, 
      negCaseSens: false, negIsRegex: false 
    }]);
  };

  const removeTargetFilter = (id: string) => {
    if (targetFilters.length > 1) {
      setTargetFilters(prev => prev.filter(item => item.id !== id));
    } else {
      updateTargetFilter(id, 'posText', '');
      updateTargetFilter(id, 'negText', '');
    }
  };
  
  const handleClearTargetFilters = () => {
    setTargetFilters([{ 
      id: Date.now().toString(), 
      posText: '', negText: '', 
      whole: false, 
      posCaseSens: false, posIsRegex: false, 
      negCaseSens: false, negIsRegex: false 
    }]);
    setTargetLogic('AND');
  };

  const updateTargetFilter = (id: string, field: keyof TargetFilterItem, value: any) => {
    setTargetFilters(prev => prev.map(item => item.id === id ? { ...item, [field]: value } : item));
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

  const checkRegexValidity = (pattern: string) => {
      if (!pattern) return true;
      try { new RegExp(pattern); return true; } catch(e) { return false; }
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
                        <div className="flex justify-between items-center mb-2">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block">Search by Key</label>
                            {(keyCount > 0 || keyNegCount > 0) && (
                                <div className="flex items-center gap-2">
                                     {keyCount > 0 && (
                                         <span className="text-[10px] text-cyan-400 bg-cyan-900/30 px-2 py-0.5 rounded border border-cyan-800 font-mono">
                                            {keyCount} pos
                                         </span>
                                     )}
                                     {keyNegCount > 0 && (
                                         <span className="text-[10px] text-red-400 bg-red-900/30 px-2 py-0.5 rounded border border-red-800 font-mono">
                                            {keyNegCount} neg
                                         </span>
                                     )}
                                     <button onClick={() => { setKeySearch(''); setKeyNegativeSearch(''); }} className="text-[10px] text-gray-500 hover:text-red-400 transition-colors">Clear</button>
                                </div>
                            )}
                        </div>
                        
                        <div className="space-y-2">
                            {/* Positive Key Input */}
                            <div className="flex">
                                <span className="inline-flex items-center justify-center px-2 bg-white text-gray-900 text-xs font-bold rounded-l min-w-[3rem] border-r-0 self-stretch">Pos</span>
                                <textarea
                                    value={keySearch} 
                                    onChange={(e)=>setKeySearch(e.target.value)} 
                                    placeholder={isKeyRegex ? "Regex pattern..." : "Paste keys here..."}
                                    className={`w-full bg-gray-900 border rounded-r px-3 py-2 text-sm focus:ring-1 focus:ring-cyan-500 outline-none h-24 resize-y custom-scrollbar font-mono text-xs ${isKeyRegex && !checkRegexValidity(keySearch) ? 'border-red-500 focus:border-red-500' : 'border-gray-700'}`}
                                />
                            </div>

                            {/* Negative Key Input */}
                            <div className="flex">
                                <span className="inline-flex items-center justify-center px-2 bg-white text-gray-900 text-xs font-bold rounded-l min-w-[3rem] border-r-0 self-stretch">Neg</span>
                                <textarea
                                    value={keyNegativeSearch} 
                                    onChange={(e)=>setKeyNegativeSearch(e.target.value)} 
                                    placeholder={isKeyNegativeRegex ? "Regex pattern (Exclude)..." : "Exclude keys..."}
                                    className={`w-full bg-gray-900 border rounded-r px-3 py-2 text-sm focus:ring-1 focus:ring-red-500 outline-none h-24 resize-y custom-scrollbar font-mono text-xs ${isKeyNegativeRegex && !checkRegexValidity(keyNegativeSearch) ? 'border-red-500 focus:border-red-500' : 'border-gray-700'}`}
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-y-2 mt-3">
                            <label className={`flex items-center text-xs text-gray-400 cursor-pointer ${isKeyRegex || isKeyNegativeRegex ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                <input type="checkbox" checked={matchKeyWholeWord} onChange={(e)=>setMatchKeyWholeWord(e.target.checked)} disabled={isKeyRegex || isKeyNegativeRegex} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/> Match whole
                            </label>
                            
                            {/* Positive Options */}
                            <div className="flex gap-3 col-span-1">
                                <label className="flex items-center text-xs text-gray-400 cursor-pointer">
                                    <input type="checkbox" checked={matchKeyCase} onChange={(e)=>setMatchKeyCase(e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/> Match case (Pos)
                                </label>
                                <label className="flex items-center text-xs text-yellow-400 cursor-pointer">
                                    <input type="checkbox" checked={isKeyRegex} onChange={(e)=>setIsKeyRegex(e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-yellow-500"/> Regex (Pos)
                                </label>
                            </div>

                            {/* Negative Options */}
                            <div className="flex gap-3 col-span-2 mt-1">
                                <label className="flex items-center text-xs text-gray-400 cursor-pointer">
                                    <input type="checkbox" checked={matchKeyNegativeCase} onChange={(e)=>setMatchKeyNegativeCase(e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-red-500"/> Match case (Neg)
                                </label>
                                <label className="flex items-center text-xs text-yellow-400 cursor-pointer">
                                    <input type="checkbox" checked={isKeyNegativeRegex} onChange={(e)=>setIsKeyNegativeRegex(e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-yellow-500"/> Regex (Neg)
                                </label>
                            </div>
                        </div>
                    </section>

                    <section className="bg-gray-700/20 p-3 rounded border border-gray-700/50">
                        <div className="flex justify-between items-center mb-2">
                            <div className="flex items-center gap-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Source (en-US)</label>
                                {(sourceFilters.length > 1 || sourceFilters[0].text) && (
                                    <button onClick={handleClearSourceFilters} className="text-[10px] text-gray-500 hover:text-red-400 transition-colors">Clear</button>
                                )}
                            </div>
                            <div className="flex bg-gray-900 rounded p-0.5 border border-gray-700">
                                <button 
                                    onClick={() => setSourceLogic('AND')}
                                    className={`text-[10px] px-2 py-0.5 rounded transition-colors ${sourceLogic === 'AND' ? 'bg-cyan-600 text-white font-bold' : 'text-gray-400 hover:text-white'}`}
                                >
                                    AND
                                </button>
                                <button 
                                    onClick={() => setSourceLogic('OR')}
                                    className={`text-[10px] px-2 py-0.5 rounded transition-colors ${sourceLogic === 'OR' ? 'bg-cyan-600 text-white font-bold' : 'text-gray-400 hover:text-white'}`}
                                >
                                    OR
                                </button>
                            </div>
                        </div>

                        <div className="space-y-4">
                          {sourceFilters.map((filter) => (
                            <div key={filter.id} className="relative group animate-fadeIn">
                                <div className="flex gap-2 items-center">
                                     <input 
                                        type="text" 
                                        value={filter.text}
                                        onChange={(e) => updateSourceFilter(filter.id, 'text', e.target.value)}
                                        placeholder={filter.isRegex ? "Regex pattern..." : "Search text..."}
                                        className={`flex-1 min-w-0 bg-gray-900 border rounded px-3 py-2 text-sm focus:ring-1 focus:ring-cyan-500 outline-none ${filter.isRegex && !checkRegexValidity(filter.text) ? 'border-red-500 focus:border-red-500' : 'border-gray-700'}`}
                                     />
                                     {sourceFilters.length > 1 && (
                                         <button onClick={() => removeSourceFilter(filter.id)} className="text-gray-500 hover:text-red-400 p-1 rounded hover:bg-gray-700/50 transition-colors" title="Remove condition">
                                             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                                            </svg>
                                         </button>
                                     )}
                                </div>
                                <div className="flex gap-4 mt-2">
                                    <label className={`flex items-center text-xs text-gray-400 cursor-pointer select-none ${filter.isRegex ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                        <input type="checkbox" checked={filter.whole} onChange={(e) => updateSourceFilter(filter.id, 'whole', e.target.checked)} disabled={filter.isRegex} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/>
                                        Match whole
                                    </label>
                                    <label className="flex items-center text-xs text-gray-400 cursor-pointer select-none">
                                        <input type="checkbox" checked={filter.caseSens} onChange={(e) => updateSourceFilter(filter.id, 'caseSens', e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/>
                                        Match case
                                    </label>
                                    <label className="flex items-center text-xs text-yellow-400 cursor-pointer select-none">
                                        <input type="checkbox" checked={filter.isRegex} onChange={(e) => updateSourceFilter(filter.id, 'isRegex', e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-yellow-500"/>
                                        Regex
                                    </label>
                                </div>
                            </div>
                          ))}
                        </div>
                        
                        <button onClick={addSourceFilter} className="mt-3 text-xs flex items-center font-bold text-cyan-400 hover:text-cyan-300 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 mr-1">
                              <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
                            </svg>
                            Add condition
                        </button>
                    </section>

                    <section className="bg-gray-700/20 p-3 rounded border border-gray-700/50">
                        <div className="flex justify-between items-center mb-2">
                            <div className="flex items-center gap-2">
                                <label className="text-xs font-bold text-cyan-400 uppercase tracking-wider">Target Filter</label>
                                {(targetFilters.length > 1 || targetFilters[0].posText || targetFilters[0].negText) && (
                                    <button onClick={handleClearTargetFilters} className="text-[10px] text-gray-500 hover:text-red-400 transition-colors">Clear</button>
                                )}
                            </div>
                            <div className="flex bg-gray-900 rounded p-0.5 border border-gray-700">
                                <button 
                                    onClick={() => setTargetLogic('AND')}
                                    className={`text-[10px] px-2 py-0.5 rounded transition-colors ${targetLogic === 'AND' ? 'bg-cyan-600 text-white font-bold' : 'text-gray-400 hover:text-white'}`}
                                >
                                    AND
                                </button>
                                <button 
                                    onClick={() => setTargetLogic('OR')}
                                    className={`text-[10px] px-2 py-0.5 rounded transition-colors ${targetLogic === 'OR' ? 'bg-cyan-600 text-white font-bold' : 'text-gray-400 hover:text-white'}`}
                                >
                                    OR
                                </button>
                            </div>
                        </div>
                        
                        <div className="space-y-4">
                        {targetFilters.map((filter) => (
                           <div key={filter.id} className="relative group animate-fadeIn pb-4 border-b border-gray-700/30 last:border-0 last:pb-0">
                                <div className="flex mb-2 gap-2">
                                    <span className="inline-flex items-center justify-center px-3 bg-white text-gray-900 text-xs font-bold rounded min-w-[3.5rem] h-[34px]">Pos</span>
                                    <div className="flex-1 min-w-0 relative">
                                      <input 
                                          type="text" 
                                          value={filter.posText} 
                                          onChange={(e)=>updateTargetFilter(filter.id, 'posText', e.target.value)} 
                                          placeholder="Positive keyword..." 
                                          className={`w-full bg-gray-900 border rounded px-3 py-2 text-sm focus:ring-1 focus:ring-cyan-500 outline-none ${filter.posIsRegex && !checkRegexValidity(filter.posText) ? 'border-red-500 focus:border-red-500' : 'border-gray-700'}`}
                                      />
                                      {targetFilters.length > 1 && (
                                         <button onClick={() => removeTargetFilter(filter.id)} className="absolute right-1 top-1.5 text-gray-500 hover:text-red-400 p-0.5 rounded hover:bg-gray-700/50 transition-colors" title="Remove condition">
                                             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                                            </svg>
                                         </button>
                                      )}
                                    </div>
                                </div>

                                <div className="flex gap-2">
                                    <span className="inline-flex items-center justify-center px-3 bg-white text-gray-900 text-xs font-bold rounded min-w-[3.5rem] h-[34px]">Neg</span>
                                    <input 
                                        type="text" 
                                        value={filter.negText} 
                                        onChange={(e)=>updateTargetFilter(filter.id, 'negText', e.target.value)} 
                                        placeholder="Negative keyword (Exclude)..." 
                                        className={`flex-1 min-w-0 bg-gray-900 border rounded px-3 py-2 text-sm focus:ring-1 focus:ring-red-500 outline-none ${filter.negIsRegex && !checkRegexValidity(filter.negText) ? 'border-red-500 focus:border-red-500' : 'border-red-900/50'}`}
                                    />
                                </div>
                                
                                <div className="grid grid-cols-2 gap-y-2 mt-3 pl-1">
                                    <label className={`flex items-center text-xs text-gray-400 cursor-pointer ${filter.posIsRegex || filter.negIsRegex ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                        <input type="checkbox" checked={filter.whole} onChange={(e)=>updateTargetFilter(filter.id, 'whole', e.target.checked)} disabled={filter.posIsRegex || filter.negIsRegex} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/> Match whole
                                    </label>
                                    
                                    {/* Positive Options */}
                                    <div className="flex gap-3 col-span-1">
                                        <label className="flex items-center text-xs text-gray-400 cursor-pointer">
                                            <input type="checkbox" checked={filter.posCaseSens} onChange={(e)=>updateTargetFilter(filter.id, 'posCaseSens', e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-cyan-500"/> Match case (Pos)
                                        </label>
                                        <label className="flex items-center text-xs text-yellow-400 cursor-pointer">
                                            <input type="checkbox" checked={filter.posIsRegex} onChange={(e)=>updateTargetFilter(filter.id, 'posIsRegex', e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-yellow-500"/> Regex (Pos)
                                        </label>
                                    </div>

                                    {/* Negative Options */}
                                    <div className="flex gap-3 col-span-2 mt-1">
                                        <label className="flex items-center text-xs text-gray-400 cursor-pointer">
                                            <input type="checkbox" checked={filter.negCaseSens} onChange={(e)=>updateTargetFilter(filter.id, 'negCaseSens', e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-red-500"/> Match case (Neg)
                                        </label>
                                        <label className="flex items-center text-xs text-yellow-400 cursor-pointer">
                                            <input type="checkbox" checked={filter.negIsRegex} onChange={(e)=>updateTargetFilter(filter.id, 'negIsRegex', e.target.checked)} className="mr-1.5 h-3.5 w-3.5 accent-yellow-500"/> Regex (Neg)
                                        </label>
                                    </div>
                                </div>
                           </div>
                        ))}
                        </div>

                        <button onClick={addTargetFilter} className="mt-3 text-xs flex items-center font-bold text-cyan-400 hover:text-cyan-300 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 mr-1">
                              <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
                            </svg>
                            Add condition
                        </button>
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
          @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
          .animate-fadeIn { animation: fadeIn 0.2s ease-out; }
      `}</style>
    </div>
  );
};

export default App;
