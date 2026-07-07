import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  DragCancelEvent,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  useDraggable,
  useDroppable,
  MeasuringStrategy,
} from '@dnd-kit/core';
import { AlertTriangle, RefreshCw, Trash2, CalendarIcon, X, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { isWithinInterval, startOfMonth, endOfMonth, startOfDay, endOfDay, format } from 'date-fns';
import {
  calculateItemAmount,
  MonthData,
  CostItem,
  XeroData,
  CostItemWithBoard as ImportedCostItemWithBoard,
  loadCostsConfig,
  saveCostsConfig,
  saveCostsConfigToSupabase,
  CostsConfig,
} from '@/lib/costsCalculator';
import {
  fetchCostProfiles,
  saveCostProfiles,
  profileToConfig,
  SEED_PROFILES,
  type CostProfile,
} from '@/lib/costsProfiles';

interface DateRange {
  from?: Date;
  to?: Date;
}

interface CostItemWithBoard extends ImportedCostItemWithBoard {
  id: string;
  notes: string;
}

interface BoardTotals {
  b2c: number;
  b2b: number;
}

interface ExcludedItem {
  item: CostItemWithBoard;
  originalBoard: 'fixed' | 'variable' | 'andrea' | 'pool';
}

const BOARD_NAMES = {
  fixed: 'Fixed costs',
  variable: 'Variable costs',
  andrea: "Andrea's costs",
  pool: 'Pool',
} as const;

const checkDateRangeWarning = (
  xeroData: XeroData | null,
  dateRange: DateRange
): string => {
  if (!xeroData || !dateRange.from || !dateRange.to || xeroData.months.length === 0) return '';

  const availableStart = startOfDay(new Date(xeroData.months[0].year, xeroData.months[0].month - 1, 1));

  let availableEnd: Date;
  if (xeroData.periodEnd) {
    availableEnd = endOfDay(new Date(xeroData.periodEnd));
  } else {
    availableEnd = endOfDay(endOfMonth(
      new Date(xeroData.months[xeroData.months.length - 1].year, xeroData.months[xeroData.months.length - 1].month - 1, 1)
    ));
  }

  const rangeStart = startOfDay(dateRange.from);
  const rangeEnd = endOfDay(dateRange.to);

  const isFullyOutside = rangeEnd < availableStart || rangeStart > availableEnd;
  const isPartialOutside =
    (rangeStart < availableStart && rangeEnd >= availableStart) ||
    (rangeEnd > availableEnd && rangeStart <= availableEnd);

  if (isFullyOutside) {
    return 'Selected date range is outside available data; costs are 0.';
  }

  if (isPartialOutside) {
    if (rangeEnd > availableEnd) {
      return `Data only available up to ${format(availableEnd, "LLL dd, y")}; costs are partial.`;
    }
    return 'Date range exceeds available data; costs are partial.';
  }

  return '';
};

function CostsCanvas({ dateRange, setDateRange }: { dateRange: DateRange; setDateRange: (range: DateRange) => void }) {
  const [xeroData, setXeroData] = useState<XeroData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<CostItemWithBoard[]>([]);
  const [excludedItems, setExcludedItems] = useState<Map<string, ExcludedItem>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [isTrashModalOpen, setIsTrashModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<CostItemWithBoard | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [profiles, setProfiles] = useState<CostProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>(() => {
    try { return localStorage.getItem('costs-active-profile') ?? ''; } catch { return ''; }
  });
  const [profilesBusy, setProfilesBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const saveToSupabaseTimerRef = useRef<NodeJS.Timeout | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const activeItem = useMemo(() => {
    if (!activeId) return null;
    const item = items.find((i) => i.id === activeId);
    if (item) return item;
    const excluded = excludedItems.get(activeId);
    return excluded?.item || null;
  }, [activeId, items, excludedItems]);

  const boardTotals = useMemo<Record<string, BoardTotals>>(() => {
    if (!xeroData) return { fixed: { b2c: 0, b2b: 0 }, variable: { b2c: 0, b2b: 0 }, andrea: { b2c: 0, b2b: 0 } };

    const totals: Record<string, BoardTotals> = {
      fixed: { b2c: 0, b2b: 0 },
      variable: { b2c: 0, b2b: 0 },
      andrea: { b2c: 0, b2b: 0 },
    };

    items.forEach((item) => {
      if (item.board === 'pool') return;

      const amount = calculateItemAmount(item, xeroData.months, dateRange, xeroData.periodEnd);
      const b2cPercent = (100 - item.sliderValue) / 100;
      const b2bPercent = item.sliderValue / 100;

      totals[item.board].b2c += amount * b2cPercent;
      totals[item.board].b2b += amount * b2bPercent;
    });

    return totals;
  }, [items, xeroData, dateRange]);

  const warningMessage = xeroData && !loading ? checkDateRangeWarning(xeroData, dateRange) : '';

  useEffect(() => {
    if (!xeroData || !dateRange.from || !dateRange.to) return;

    const itemizedBreakdown = items
      .filter((item) => item.board !== 'pool')
      .map((item) => {
        const amount = calculateItemAmount(item, xeroData.months, dateRange, xeroData.periodEnd);
        const b2cPercent = (100 - item.sliderValue) / 100;
        const b2bPercent = item.sliderValue / 100;

        return {
          name: item.name,
          board: item.board,
          b2cAmount: amount * b2cPercent,
          b2bAmount: amount * b2bPercent,
        };
      });

    const snapshot = {
      dateRange: {
        from: dateRange.from.toISOString(),
        to: dateRange.to.toISOString(),
      },
      totals: {
        fixed: boardTotals.fixed,
        variable: boardTotals.variable,
        andrea: boardTotals.andrea,
      },
      items: itemizedBreakdown,
    };

    localStorage.setItem('costs-canvas-snapshot', JSON.stringify(snapshot));
  }, [items, dateRange, boardTotals, xeroData]);

  useEffect(() => {
    const config = loadCostsConfig();

    const assignments = config.boards;
    const sliders = config.sliders;
    const adjustments: Record<string, number> = {};
    const notes: Record<string, string> = {};
    Object.keys(config.adjustments).forEach((itemName) => {
      adjustments[itemName] = config.adjustments[itemName].percent;
      notes[itemName] = config.adjustments[itemName].note;
    });

    fetchXeroData(assignments, sliders, adjustments, notes);
  }, []);

  useEffect(() => {
    return () => {
      if (saveToSupabaseTimerRef.current) {
        clearTimeout(saveToSupabaseTimerRef.current);
      }
    };
  }, []);

  const fetchXeroData = async (
    assignments: Record<string, 'fixed' | 'variable' | 'andrea' | 'pool'>,
    sliders: Record<string, number>,
    adjustments: Record<string, number>,
    notes: Record<string, string>
  ) => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-xero-costs`,
        {
          headers: {
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch Xero costs data');
      }

      const data: XeroData = await response.json();
      setXeroData(data);

      const config = loadCostsConfig();
      const excludedMap = new Map<string, ExcludedItem>();
      Object.keys(config.excluded).forEach((itemName) => {
        if (config.excluded[itemName]) {
          const matchingItem = data.items.find(i => i.name === itemName);
          if (matchingItem) {
            excludedMap.set(itemName, {
              item: {
                ...matchingItem,
                board: assignments[itemName] || 'pool',
                sliderValue: sliders[itemName] !== undefined ? sliders[itemName] : 50,
                adjustmentPercent: adjustments[itemName] !== undefined ? adjustments[itemName] : 100,
                notes: notes[itemName] || '',
                id: itemName,
              },
              originalBoard: assignments[itemName] || 'pool',
            });
          }
        }
      });

      const itemsWithBoard: CostItemWithBoard[] = data.items
        .filter((item) => !config.excluded[item.name])
        .map((item) => ({
          ...item,
          board: assignments[item.name] || 'pool',
          sliderValue: sliders[item.name] !== undefined ? sliders[item.name] : 50,
          adjustmentPercent: adjustments[item.name] !== undefined ? adjustments[item.name] : 100,
          notes: notes[item.name] || '',
          id: item.name,
        }));

      setExcludedItems(excludedMap);
      setItems(itemsWithBoard);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const updateConfig = (updatedItems: CostItemWithBoard[], excludedMap: Map<string, ExcludedItem>) => {
    const config = loadCostsConfig();

    config.boards = {};
    config.sliders = {};
    config.adjustments = {};

    updatedItems.forEach((item) => {
      if (item.board !== 'pool') {
        config.boards[item.name] = item.board;
      }
      config.sliders[item.name] = item.sliderValue;
      config.adjustments[item.name] = {
        percent: item.adjustmentPercent,
        note: item.notes,
      };
    });

    config.excluded = {};
    excludedMap.forEach((_, key) => {
      config.excluded[key] = true;
    });

    saveCostsConfig(config);

    if (saveToSupabaseTimerRef.current) {
      clearTimeout(saveToSupabaseTimerRef.current);
    }

    saveToSupabaseTimerRef.current = setTimeout(() => {
      saveCostsConfigToSupabase(config).catch((error) => {
        console.error('Failed to save costs config to Supabase:', error);
      });
    }, 500);
  };

  // ─── Cost Profiles ──────────────────────────────────────────────────────────

  useEffect(() => {
    // Load saved profiles; seed the three defaults on first ever run.
    fetchCostProfiles()
      .then((list) => {
        if (list.length === 0) {
          setProfiles(SEED_PROFILES);
          saveCostProfiles(SEED_PROFILES).catch(() => {});
        } else {
          setProfiles(list);
        }
      })
      .catch((e) => console.error('Failed to load cost profiles:', e));
  }, []);

  /** Snapshot of the current canvas state as a CostsConfig. */
  const buildConfigFromState = (): CostsConfig => {
    const config: CostsConfig = {
      schemaVersion: 1,
      boards: {},
      sliders: {},
      adjustments: {},
      excluded: {},
      updatedAt: new Date().toISOString(),
    };
    items.forEach((item) => {
      if (item.board !== 'pool') config.boards[item.name] = item.board;
      config.sliders[item.name] = item.sliderValue;
      config.adjustments[item.name] = { percent: item.adjustmentPercent, note: item.notes };
    });
    excludedItems.forEach((_, key) => { config.excluded[key] = true; });
    return config;
  };

  /** Rebuild the canvas (items + excluded) from a config, and persist it as
   *  the ACTIVE config so every downstream consumer follows the profile. */
  const applyConfig = (config: CostsConfig) => {
    if (!xeroData) return;
    const adjustments: Record<string, number> = {};
    const notes: Record<string, string> = {};
    Object.keys(config.adjustments).forEach((n) => {
      adjustments[n] = config.adjustments[n].percent;
      notes[n] = config.adjustments[n].note;
    });

    const excludedMap = new Map<string, ExcludedItem>();
    const nextItems: CostItemWithBoard[] = [];
    xeroData.items.forEach((item) => {
      const withBoard: CostItemWithBoard = {
        ...item,
        board: config.boards[item.name] || 'pool',
        sliderValue: config.sliders[item.name] !== undefined ? config.sliders[item.name] : 50,
        adjustmentPercent: adjustments[item.name] !== undefined ? adjustments[item.name] : 100,
        notes: notes[item.name] || '',
        id: item.name,
      };
      if (config.excluded[item.name]) {
        excludedMap.set(item.name, { item: withBoard, originalBoard: withBoard.board });
      } else {
        nextItems.push(withBoard);
      }
    });

    setItems(nextItems);
    setExcludedItems(excludedMap);
    updateConfig(nextItems, excludedMap);
  };

  const handleSelectProfile = (id: string) => {
    setSelectedProfileId(id);
    try { localStorage.setItem('costs-active-profile', id); } catch { /* */ }
    const profile = profiles.find((p) => p.id === id);
    if (profile) applyConfig(profileToConfig(profile));
  };

  const persistProfiles = async (next: CostProfile[]) => {
    setProfilesBusy(true);
    setProfiles(next);
    try {
      await saveCostProfiles(next);
    } finally {
      setProfilesBusy(false);
    }
  };

  const handleSaveAsProfile = () => {
    const name = window.prompt('New profile name:');
    if (!name || !name.trim()) return;
    const cfg = buildConfigFromState();
    const profile: CostProfile = {
      id: `p-${Date.now().toString(36)}`,
      name: name.trim().slice(0, 60),
      boards: cfg.boards,
      sliders: cfg.sliders,
      adjustments: cfg.adjustments,
      excluded: cfg.excluded,
      updatedAt: new Date().toISOString(),
    };
    setSelectedProfileId(profile.id);
    try { localStorage.setItem('costs-active-profile', profile.id); } catch { /* */ }
    persistProfiles([...profiles, profile]);
  };

  const handleUpdateProfile = () => {
    const idx = profiles.findIndex((p) => p.id === selectedProfileId);
    if (idx === -1) return;
    const cfg = buildConfigFromState();
    const next = [...profiles];
    next[idx] = {
      ...next[idx],
      boards: cfg.boards,
      sliders: cfg.sliders,
      adjustments: cfg.adjustments,
      excluded: cfg.excluded,
      updatedAt: new Date().toISOString(),
    };
    persistProfiles(next);
  };

  const handleDeleteProfile = () => {
    const profile = profiles.find((p) => p.id === selectedProfileId);
    if (!profile) return;
    if (!window.confirm(`Delete profile "${profile.name}"? The current canvas keeps its state.`)) return;
    setSelectedProfileId('');
    try { localStorage.removeItem('costs-active-profile'); } catch { /* */ }
    persistProfiles(profiles.filter((p) => p.id !== selectedProfileId));
  };

  /** True when the canvas differs from the selected profile — drives the
   *  "Save changes" button so edits are never silently lost. */
  const profileDirty = useMemo(() => {
    const profile = profiles.find((p) => p.id === selectedProfileId);
    if (!profile || loading) return false;
    const cfg = {
      boards: {} as Record<string, string>,
      sliders: {} as Record<string, number>,
      excluded: {} as Record<string, boolean>,
    };
    items.forEach((item) => {
      if (item.board !== 'pool') cfg.boards[item.name] = item.board;
      cfg.sliders[item.name] = item.sliderValue;
    });
    excludedItems.forEach((_, key) => { cfg.excluded[key] = true; });

    // Build one canonical, order-independent signature per side over the SAME
    // universe of accounts (everything currently visible: columns + trash).
    // Each account maps to [state, slider], where state is its board, 'pool',
    // or 'excluded'. Comparing sorted signatures is robust to key order.
    const universe = new Set<string>([
      ...items.map((i) => i.name),
      ...Array.from(excludedItems.keys()),
    ]);

    const canvasSig = Array.from(universe).sort().map((name) => {
      const state = cfg.excluded[name] ? 'excluded' : (cfg.boards[name] ?? 'pool');
      const slider = cfg.sliders[name] !== undefined ? cfg.sliders[name] : 50;
      return `${name}|${state}|${slider}`;
    });

    const profileSig = Array.from(universe).sort().map((name) => {
      const state = profile.excluded[name] ? 'excluded' : (profile.boards[name] ?? 'pool');
      const slider = profile.sliders[name] !== undefined ? profile.sliders[name] : 50;
      return `${name}|${state}|${slider}`;
    });

    return JSON.stringify(canvasSig) !== JSON.stringify(profileSig);
  }, [items, excludedItems, profiles, selectedProfileId, loading]);

  const handleSliderChange = (itemId: string, value: number[]) => {
    setItems((prev) => {
      const updated = prev.map((item) =>
        item.id === itemId ? { ...item, sliderValue: value[0] } : item
      );

      updateConfig(updated, excludedItems);

      return updated;
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
    setIsDragging(true);

    if (scrollRef.current) {
      let scrollContainer = scrollRef.current.parentElement;
      while (scrollContainer) {
        const overflowY = window.getComputedStyle(scrollContainer).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') {
          scrollContainerRef.current = scrollContainer;
          scrollContainer.style.overflow = "hidden";
          scrollContainer.style.touchAction = "none";
          break;
        }
        scrollContainer = scrollContainer.parentElement;
      }
    }
    document.body.style.overflow = "hidden";
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setIsDragging(false);

    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.overflow = "";
      scrollContainerRef.current.style.touchAction = "";
      scrollContainerRef.current = null;
    }
    document.body.style.overflow = "";

    if (!over) return;

    const itemId = active.id as string;
    const targetBoard = over.id as string;

    if (targetBoard === 'trash') {
      const itemToRemove = items.find((item) => item.id === itemId);
      if (!itemToRemove) return;

      const updatedItems = items.filter((item) => item.id !== itemId);
      setItems(updatedItems);
      setExcludedItems((prev) => {
        const newMap = new Map(prev);
        newMap.set(itemId, {
          item: itemToRemove,
          originalBoard: itemToRemove.board,
        });
        updateConfig(updatedItems, newMap);
        return newMap;
      });
      return;
    }

    if (targetBoard === 'pool' || targetBoard === 'fixed' || targetBoard === 'variable' || targetBoard === 'andrea') {
      const excludedItem = excludedItems.get(itemId);
      if (excludedItem) {
        const restoredItem = { ...excludedItem.item, board: targetBoard as 'fixed' | 'variable' | 'andrea' | 'pool' };
        const updatedItems = [...items, restoredItem];
        setItems(updatedItems);
        setExcludedItems((prev) => {
          const newMap = new Map(prev);
          newMap.delete(itemId);
          updateConfig(updatedItems, newMap);
          return newMap;
        });
        return;
      }

      setItems((prev) => {
        const updated = prev.map((item) =>
          item.id === itemId ? { ...item, board: targetBoard as 'fixed' | 'variable' | 'andrea' | 'pool' } : item
        );

        updateConfig(updated, excludedItems);

        return updated;
      });
    }
  };

  const handleDragCancel = () => {
    setActiveId(null);
    setIsDragging(false);

    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.overflow = "";
      scrollContainerRef.current.style.touchAction = "";
      scrollContainerRef.current = null;
    }
    document.body.style.overflow = "";
  };

  const handleAdjustmentChange = (itemId: string, adjustmentPercent: number, notes: string) => {
    setItems((prev) => {
      const updated = prev.map((item) =>
        item.id === itemId ? { ...item, adjustmentPercent, notes } : item
      );

      updateConfig(updated, excludedItems);

      return updated;
    });
  };

  const handleReorderAndReset = () => {
    const config = loadCostsConfig();
    const preservedExcluded = { ...config.excluded };

    localStorage.removeItem('costs-config-v1');

    const newConfig = loadCostsConfig();
    newConfig.excluded = preservedExcluded;
    saveCostsConfig(newConfig);

    if (xeroData) {
      const resetItems: CostItemWithBoard[] = xeroData.items
        .filter((item) => !preservedExcluded[item.name])
        .map((item) => ({
          ...item,
          board: 'pool',
          sliderValue: 50,
          adjustmentPercent: 100,
          notes: '',
          id: item.name,
        }));
      setItems(resetItems);

      const excludedMap = new Map<string, ExcludedItem>();
      Object.keys(preservedExcluded).forEach((itemName) => {
        if (preservedExcluded[itemName]) {
          const matchingItem = xeroData.items.find(i => i.name === itemName);
          if (matchingItem) {
            excludedMap.set(itemName, {
              item: {
                ...matchingItem,
                board: 'pool',
                sliderValue: 50,
                adjustmentPercent: 100,
                notes: '',
                id: itemName,
              },
              originalBoard: 'fixed',
            });
          }
        }
      });
      setExcludedItems(excludedMap);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <RefreshCw className="h-6 w-6 animate-spin text-gray-400" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center text-red-600">
            <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
            <p>{error}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      collisionDetection={pointerWithin}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      autoScroll={false}
    >
      <div ref={scrollRef} className="space-y-4">
        <div className="sticky top-0 z-30 bg-white/70 backdrop-blur border-b pb-4 -mx-6 px-6 pt-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              {warningMessage && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-start gap-3"
                >
                  <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
                  <p className="text-sm text-yellow-800">
                    {warningMessage}
                  </p>
                </motion.div>
              )}
            </div>
            <TrashZone onOpenModal={() => setIsTrashModalOpen(true)} excludedCount={excludedItems.size} />
          </div>
        </div>

        {/* ─── Cost Profiles bar ─────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-gray-50/60 px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Profile</span>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-gray-200/70 hover:text-foreground"
                title="How the Costs tab works"
              >
                <HelpCircle className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" collisionPadding={12} className="w-[440px] p-0 text-sm leading-relaxed">
              <div
                className="max-h-[60vh] space-y-3 overflow-y-auto overscroll-contain p-4"
                onWheel={(e) => e.stopPropagation()}
              >
                <div>
                  <h4 className="font-semibold text-foreground">What this tab does</h4>
                  <p className="text-muted-foreground">
                    Costs come <b>live from the Xero API</b> (synced daily — see Config → Connections),
                    not from a manual file. Each expense account is placed on a board so the rest of the
                    dashboard (Cost distribution, By Channel, FY Report) knows how to treat it.
                  </p>
                </div>

                <div>
                  <h4 className="font-semibold text-foreground">The boards</h4>
                  <ul className="list-disc pl-4 text-muted-foreground space-y-0.5">
                    <li><b>Fixed</b> — structural costs that don't scale with sales (wages, software, rent-like).</li>
                    <li><b>Variable</b> — costs that scale with each sale (advertising, freight, payment fees).</li>
                    <li><b>Andrea's costs</b> — her discretionary costs, toggled separately in By Channel.</li>
                    <li><b>Pool</b> — parked / unclassified: <b>shown but NOT counted</b>. New Xero accounts land here until you place them, so nothing silently inflates a total.</li>
                    <li><b>Trash</b> — excluded from all calculations. The trash is <b>per profile</b>.</li>
                  </ul>
                </div>

                <div>
                  <h4 className="font-semibold text-foreground">What Xero sends, and what we filter</h4>
                  <p className="text-muted-foreground">
                    Only <b>Operating Expense</b> accounts reach this canvas. Income and Cost of Sales
                    accounts (Sales, cost of goods sold) are filtered out at the source — COGS is already
                    deducted per-SKU elsewhere, so counting it here would double it.
                  </p>
                </div>

                <div>
                  <h4 className="font-semibold text-foreground">Excluded on purpose (in the seed profiles)</h4>
                  <ul className="list-disc pl-4 text-muted-foreground space-y-0.5">
                    <li><b>Stock purchased</b> — inventory buys = COGS, already counted per-SKU.</li>
                    <li><b>Rates &amp; Taxes — Tax remittances</b> — GST/BAS (pass-through), income tax (below the operating line), personal tax, and super remittances (already in the Superannuation account). Not a cost of operating.</li>
                    <li><b>Foreign Currency Gains and Losses</b> — accounting revaluations, not spend.</li>
                    <li><b>Interest Expense</b>.</li>
                  </ul>
                </div>

                <div>
                  <h4 className="font-semibold text-foreground">Split accounts</h4>
                  <p className="text-muted-foreground">
                    "Rates &amp; Taxes" is split by transaction contact into <b>— Tax remittances</b> (ATO,
                    excluded), <b>— Property &amp; Compliance</b> (council rates, body corporate, ASIC, land
                    tax — a real cost) and <b>— Review / — Unclassified</b> (unknown contacts or amounts not
                    explained by transactions, e.g. accountant journals). Nothing is ever estimated.
                  </p>
                </div>

                <div>
                  <h4 className="font-semibold text-foreground">Profiles</h4>
                  <p className="text-muted-foreground">
                    A profile is a saved classification (which account sits on which board + what's trashed).
                    Switching profiles re-frames the whole dashboard. Edit anything and a <b>Save changes</b>
                    button appears to update that profile, or use <b>Save as new</b>.
                  </p>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <select
            value={selectedProfileId}
            onChange={(e) => handleSelectProfile(e.target.value)}
            className="h-8 rounded-md border bg-white px-2 text-sm"
            disabled={profilesBusy || loading}
          >
            <option value="">— custom (unsaved) —</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {selectedProfileId && profileDirty && (
            <>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                modified
              </span>
              <Button size="sm" onClick={handleUpdateProfile} disabled={profilesBusy || loading}>
                Save changes
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={handleSaveAsProfile} disabled={profilesBusy || loading}>
            Save as new…
          </Button>
          <Button variant="outline" size="sm" onClick={handleDeleteProfile} disabled={profilesBusy || loading || !selectedProfileId}>
            Delete
          </Button>
          {selectedProfileId && !profileDirty && (
            <span className="ml-1 max-w-[520px] truncate text-xs text-muted-foreground" title={profiles.find((p) => p.id === selectedProfileId)?.description}>
              {profiles.find((p) => p.id === selectedProfileId)?.description}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen} modal={true}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "justify-start text-left font-normal",
                  !dateRange && "text-muted-foreground"
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {dateRange?.from ? (
                  dateRange.to ? (
                    <>
                      {format(dateRange.from, "LLL dd, y")} -{" "}
                      {format(dateRange.to, "LLL dd, y")}
                    </>
                  ) : (
                    format(dateRange.from, "LLL dd, y")
                  )
                ) : (
                  <span>Pick a date range</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-auto p-0"
              align="start"
              side="bottom"
              onPointerDownOutside={(e) => e.preventDefault()}
              onInteractOutside={(e) => e.preventDefault()}
            >
              <Calendar
                initialFocus
                mode="range"
                defaultMonth={dateRange?.from}
                selected={dateRange as any}
                onSelect={(range) => {
                  setDateRange(range || {});
                  if (range && range.from && range.to) {
                    setIsCalendarOpen(false);
                  }
                }}
                numberOfMonths={2}
              />
            </PopoverContent>
          </Popover>

          <Button variant="outline" size="sm" onClick={handleReorderAndReset}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Reorder and reset
          </Button>
        </div>

        <PoolZone items={items.filter((item) => item.board === 'pool')} xeroData={xeroData} dateRange={dateRange} onSliderChange={handleSliderChange} onItemDoubleClick={setEditingItem} activeId={activeId} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {(['fixed', 'variable', 'andrea'] as const).map((boardType) => (
            <BoardColumn
              key={boardType}
              boardType={boardType}
              title={BOARD_NAMES[boardType]}
              items={items.filter((item) => item.board === boardType)}
              xeroData={xeroData}
              dateRange={dateRange}
              onSliderChange={handleSliderChange}
              totals={boardTotals[boardType]}
              onItemDoubleClick={setEditingItem}
              activeId={activeId}
            />
          ))}
        </div>

        {createPortal(
          <DragOverlay adjustScale={false}>
            {activeItem && xeroData && (
              <div className="cursor-grabbing">
                <ItemCard
                  item={activeItem}
                  amount={calculateItemAmount(activeItem, xeroData.months, dateRange, xeroData.periodEnd)}
                  onSliderChange={() => {}}
                  readOnly={true}
                />
              </div>
            )}
          </DragOverlay>,
          document.body
        )}

        <AnimatePresence>
          {isTrashModalOpen && (
            <TrashModal
              isOpen={isTrashModalOpen}
              onClose={() => setIsTrashModalOpen(false)}
              excludedItems={excludedItems}
              xeroData={xeroData}
              dateRange={dateRange}
              activeId={activeId}
            />
          )}
          {editingItem && (
            <AdjustmentPanel
              item={editingItem}
              onClose={() => setEditingItem(null)}
              onSave={handleAdjustmentChange}
            />
          )}
        </AnimatePresence>
      </div>
    </DndContext>
  );
}

function PoolZone({
  items,
  xeroData,
  dateRange,
  onSliderChange,
  onItemDoubleClick,
  activeId,
}: {
  items: CostItemWithBoard[];
  xeroData: XeroData | null;
  dateRange: DateRange;
  onSliderChange: (itemId: string, value: number[]) => void;
  onItemDoubleClick: (item: CostItemWithBoard) => void;
  activeId: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'pool',
  });

  if (items.length === 0) return null;

  return (
    <div
      ref={setNodeRef}
      className={`border-2 border-dashed rounded-lg p-4 bg-gray-50 transition-all duration-200 ${
        isOver ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-400 ring-offset-2' : 'border-gray-300'
      }`}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Unassigned Items Pool</h3>
        <span className="text-xs text-gray-500">{items.length} items</span>
      </div>
      <div className="flex flex-wrap gap-3 overflow-x-auto">
        {items.map((item) => (
          <div key={item.id} className="flex-shrink-0 w-64">
            <ItemCard
              item={item}
              amount={xeroData ? calculateItemAmount(item, xeroData.months, dateRange, xeroData.periodEnd) : 0}
              onSliderChange={onSliderChange}
              onDoubleClick={() => onItemDoubleClick(item)}
              isDragging={activeId === item.id}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function BoardColumn({
  boardType,
  title,
  items,
  xeroData,
  dateRange,
  onSliderChange,
  totals,
  onItemDoubleClick,
  activeId,
}: {
  boardType: 'fixed' | 'variable' | 'andrea';
  title: string;
  items: CostItemWithBoard[];
  xeroData: XeroData | null;
  dateRange: DateRange;
  onSliderChange: (itemId: string, value: number[]) => void;
  totals: BoardTotals;
  onItemDoubleClick: (item: CostItemWithBoard) => void;
  activeId: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: boardType,
  });

  return (
    <motion.div
      ref={setNodeRef}
      layout
      className={`transition-all duration-200 ${
        isOver ? 'ring-2 ring-blue-400 ring-offset-2' : ''
      }`}
    >
      <Card className="h-full flex flex-col shadow-lg">
        <CardHeader className="pb-4">
          <div className="flex items-start justify-between gap-4">
            <CardTitle className="text-lg">{title}</CardTitle>
            <div className="flex flex-col gap-1 text-right">
              <div className="flex items-center gap-2 text-xs font-semibold text-blue-700">
                <span>B2C:</span>
                <span>${totals.b2c.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              <div className="flex items-center gap-2 text-xs font-semibold text-green-700">
                <span>B2B:</span>
                <span>${totals.b2b.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 space-y-3">
          <div className="space-y-3 min-h-[200px]">
            {items.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                amount={
                  xeroData ? calculateItemAmount(item, xeroData.months, dateRange, xeroData.periodEnd) : 0
                }
                onSliderChange={onSliderChange}
                onDoubleClick={() => onItemDoubleClick(item)}
                isDragging={activeId === item.id}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function ItemCard({
  item,
  amount,
  onSliderChange,
  onDoubleClick,
  isDragging = false,
  readOnly = false,
}: {
  item: CostItemWithBoard;
  amount: number;
  onSliderChange: (itemId: string, value: number[]) => void;
  onDoubleClick?: () => void;
  isDragging?: boolean;
  readOnly?: boolean;
}) {
  const b2cPercent = 100 - item.sliderValue;
  const b2bPercent = item.sliderValue;

  const { attributes, listeners, setNodeRef } = useDraggable({
    id: item.id,
    disabled: readOnly,
  });

  const dragProps = readOnly ? {} : { ...attributes, ...listeners };

  // Virtual accounts produced by the transaction-level split (e.g.
  // "Rates & Taxes — Property & Compliance", "Freight & Courier — Inbound —
  // Container") carry a distinct violet tint so they're instantly told apart
  // from raw Xero accounts.
  const isComputed = item.name.includes(' — ');

  return (
    <motion.div
      ref={readOnly ? undefined : setNodeRef}
      {...dragProps}
      layout
      whileHover={!isDragging && !readOnly ? { scale: 1.02, boxShadow: '0 10px 30px rgba(0,0,0,0.15)' } : {}}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: isDragging ? 0 : 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      className={`border-2 rounded-lg p-4 shadow-lg transition-all ${
        readOnly ? 'border-blue-400 shadow-2xl bg-blue-50 cursor-grabbing' :
        isDragging ? 'border-blue-400 shadow-2xl bg-blue-50 opacity-0' :
        isComputed ? 'border-violet-300 bg-violet-50 hover:shadow-xl cursor-move' :
        'bg-white border-gray-200 hover:shadow-xl cursor-move'
      }`}
      onDoubleClick={readOnly ? undefined : onDoubleClick}
      style={{ visibility: isDragging ? 'hidden' : 'visible' }}
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-1">
            <h4 className="font-medium text-sm leading-tight">{item.name}</h4>
            {isComputed && (
              <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700" title="Computed from a transaction-level split">
                split
              </span>
            )}
            {item.adjustmentPercent !== 100 && (
              <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded">
                Adj: {item.adjustmentPercent}%
              </span>
            )}
          </div>
          <span className="text-sm font-semibold text-gray-700 whitespace-nowrap">
            ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>

        <div className="space-y-2">
          <Slider
            value={[item.sliderValue]}
            onValueChange={(value: number[]) => onSliderChange(item.id, value)}
            min={0}
            max={100}
            step={1}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-gray-600">
            <span className="text-blue-600 font-medium">B2C: {b2cPercent}%</span>
            <span className="text-green-600 font-medium">B2B: {b2bPercent}%</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function TrashModal({
  isOpen,
  onClose,
  excludedItems,
  xeroData,
  dateRange,
  activeId,
}: {
  isOpen: boolean;
  onClose: () => void;
  excludedItems: Map<string, ExcludedItem>;
  xeroData: XeroData | null;
  dateRange: DateRange;
  activeId: string | null;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/20 z-[150] flex items-start justify-end p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 20 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        className="bg-white rounded-lg shadow-2xl w-96 max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b flex items-center justify-between bg-gray-50">
          <div className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-gray-600" />
            <h3 className="font-semibold text-gray-900">Items eliminados</h3>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {excludedItems.size === 0 ? (
            <p className="text-center text-gray-500 py-8">No hay items eliminados</p>
          ) : (
            Array.from(excludedItems.values()).map(({ item }) => (
              <TrashItemCard
                key={item.id}
                item={item}
                amount={xeroData ? calculateItemAmount(item, xeroData.months, dateRange, xeroData.periodEnd) : 0}
                isDragging={activeId === item.id}
              />
            ))
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function TrashItemCard({
  item,
  amount,
  isDragging = false,
}: {
  item: CostItemWithBoard;
  amount: number;
  isDragging?: boolean;
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: item.id,
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="bg-gray-50 border-2 border-gray-200 rounded-lg p-3 cursor-move hover:border-blue-400 hover:shadow-md transition-all"
      style={{ visibility: isDragging ? 'hidden' : 'visible', opacity: isDragging ? 0 : 1 }}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="font-medium text-sm leading-tight flex-1">{item.name}</h4>
        <span className="text-xs font-semibold text-gray-700 whitespace-nowrap">
          ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
      <div className="mt-2 text-xs text-gray-500">
        Arrastra para restaurar a {BOARD_NAMES[item.board]}
      </div>
    </div>
  );
}

function AdjustmentPanel({
  item,
  onClose,
  onSave,
}: {
  item: CostItemWithBoard;
  onClose: () => void;
  onSave: (itemId: string, adjustmentPercent: number, notes: string) => void;
}) {
  const [adjustmentPercent, setAdjustmentPercent] = useState(item.adjustmentPercent);
  const [notes, setNotes] = useState(item.notes);

  const handleSave = () => {
    onSave(item.id, adjustmentPercent, notes);
    onClose();
  };

  return (
    <Sheet open={true} onOpenChange={onClose}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Adjust Item</SheetTitle>
        </SheetHeader>

        <div className="py-6 space-y-6">
          <div>
            <h4 className="font-medium text-sm text-gray-900">{item.name}</h4>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-gray-700">Adjustment Percent</label>
              <span className="text-sm font-semibold text-gray-900">{adjustmentPercent}%</span>
            </div>
            <Slider
              value={[adjustmentPercent]}
              onValueChange={(value: number[]) => setAdjustmentPercent(value[0])}
              min={0}
              max={100}
              step={1}
              className="w-full"
            />
            <p className="text-xs text-gray-500">
              Adjust the cost amount by this percentage (100% = no change)
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Notes</label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add any notes about this adjustment..."
              className="w-full min-h-[120px] resize-none"
            />
          </div>
        </div>

        <SheetFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function TrashZone({ onOpenModal, excludedCount }: { onOpenModal: () => void; excludedCount: number }) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'trash',
  });

  return (
    <button
      ref={setNodeRef}
      onClick={onOpenModal}
      className={`p-4 rounded-full shadow-xl cursor-pointer hover:shadow-2xl transition-all duration-200 relative ${
        isOver
          ? 'bg-red-500 text-white scale-110'
          : 'bg-white border-2 border-gray-300 text-gray-600 hover:border-gray-400 scale-100'
      }`}
    >
      <Trash2 className="h-8 w-8" />
      {excludedCount > 0 && (
        <div className="absolute -top-2 -right-2 bg-red-500 text-white text-xs font-bold rounded-full h-6 w-6 flex items-center justify-center">
          {excludedCount}
        </div>
      )}
    </button>
  );
}

export default CostsCanvas;
