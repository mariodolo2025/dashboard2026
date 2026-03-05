import { differenceInDays, getDaysInMonth, endOfMonth } from 'date-fns';

const UNIFIED_CONFIG_KEY = 'costs-config-v1';

export interface CostsConfig {
  schemaVersion: number;
  boards: Record<string, 'fixed' | 'variable' | 'andrea' | 'pool'>;
  sliders: Record<string, number>;
  adjustments: Record<string, { percent: number; note: string }>;
  excluded: Record<string, boolean>;
  updatedAt: string;
}

export interface MonthData {
  index: number;
  label: string;
  year: number;
  month: number;
}

export interface CostItem {
  name: string;
  monthly: number[];
}

export interface XeroData {
  months: MonthData[];
  items: CostItem[];
  periodEnd?: string;
}

export interface CostItemWithBoard extends CostItem {
  board: 'fixed' | 'variable' | 'andrea' | 'pool';
  sliderValue: number;
  adjustmentPercent: number;
}

export interface DateRange {
  from?: Date;
  to?: Date;
}

export interface BoardTotals {
  b2c: number;
  b2b: number;
}

export interface CostsSnapshotItem {
  name: string;
  board: 'fixed' | 'variable' | 'andrea';
  adjustedAmount: number;
  b2cAmount: number;
  b2bAmount: number;
}

export interface CostsSnapshot {
  dateRange: {
    from: string;
    to: string;
  };
  totals: {
    fixed: BoardTotals;
    variable: BoardTotals;
    andrea: BoardTotals;
  };
  items: CostsSnapshotItem[];
}

function getBrisbaneToday(): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Brisbane',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const y = Number(parts.find(p => p.type === 'year')?.value);
  const m = Number(parts.find(p => p.type === 'month')?.value);
  const d = Number(parts.find(p => p.type === 'day')?.value);

  return new Date(y, m - 1, d);
}

export const calculateItemAmount = (
  item: CostItem | CostItemWithBoard,
  months: MonthData[],
  dateRange: DateRange,
  periodEnd?: string
): number => {
  if (!dateRange.from || !dateRange.to) return 0;

  let total = 0;
  const rangeFrom = dateRange.from;
  const rangeTo = dateRange.to;

  let currentMonthInfo: { year: number; month: number; dayOfMonth: number } | null = null;
  if (periodEnd) {
    const periodEndDate = new Date(periodEnd);
    currentMonthInfo = {
      year: periodEndDate.getFullYear(),
      month: periodEndDate.getMonth() + 1,
      dayOfMonth: periodEndDate.getDate()
    };
  }

  months.forEach((monthData, idx) => {
    if (idx >= item.monthly.length) return;

    const monthStart = new Date(monthData.year, monthData.month - 1, 1);
    const monthEnd = endOfMonth(monthStart);

    const overlapStart = rangeFrom > monthStart ? rangeFrom : monthStart;
    const overlapEnd = rangeTo < monthEnd ? rangeTo : monthEnd;

    if (overlapStart <= overlapEnd) {
      const daysSelected = differenceInDays(overlapEnd, overlapStart) + 1;

      const isCurrentMonth = currentMonthInfo &&
        monthData.year === currentMonthInfo.year &&
        monthData.month === currentMonthInfo.month;

      if (isCurrentMonth && currentMonthInfo) {
        const periodEndDate = new Date(periodEnd!);
        const todayBrisbane = getBrisbaneToday();
        const days_elapsed_for_current_month = Math.min(
          periodEndDate.getDate(),
          todayBrisbane.getDate()
        );
        const dataEndDate = new Date(
          monthData.year,
          monthData.month - 1,
          days_elapsed_for_current_month
        );

        const isFullRangeWithinElapsed =
          overlapStart.getTime() === monthStart.getTime() &&
          overlapEnd.getTime() === dataEndDate.getTime();

        if (isFullRangeWithinElapsed) {
          total += item.monthly[idx];
        } else {
          const prorationFactor = daysSelected / days_elapsed_for_current_month;
          total += item.monthly[idx] * prorationFactor;
        }
      } else {
        const daysInMonth = getDaysInMonth(monthStart);
        const prorationFactor = daysSelected / daysInMonth;
        total += item.monthly[idx] * prorationFactor;
      }
    }
  });

  const adjustmentPercent = 'adjustmentPercent' in item ? item.adjustmentPercent : 100;
  return total * (adjustmentPercent / 100);
};

export const loadCostsConfig = (): CostsConfig => {
  try {
    const saved = localStorage.getItem(UNIFIED_CONFIG_KEY);
    if (saved) {
      return JSON.parse(saved) as CostsConfig;
    }

    const migratedConfig = migrateOldConfig();
    if (migratedConfig) {
      saveCostsConfig(migratedConfig);
      return migratedConfig;
    }

    return {
      schemaVersion: 1,
      boards: {},
      sliders: {},
      adjustments: {},
      excluded: {},
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error loading costs config:', error);
    return {
      schemaVersion: 1,
      boards: {},
      sliders: {},
      adjustments: {},
      excluded: {},
      updatedAt: new Date().toISOString(),
    };
  }
};

export const saveCostsConfig = (config: CostsConfig): void => {
  try {
    const updatedConfig = {
      ...config,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(UNIFIED_CONFIG_KEY, JSON.stringify(updatedConfig));
    window.dispatchEvent(new CustomEvent('costs:updated'));
  } catch (error) {
    console.error('Error saving costs config:', error);
  }
};

export const loadCostsConfigFromSupabase = async (): Promise<CostsConfig | null> => {
  try {
    const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/costs-config`;
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error('Failed to load costs config from Supabase:', response.statusText);
      return null;
    }

    const result = await response.json();
    if (result.success && result.settings_json) {
      return result.settings_json as CostsConfig;
    }

    return null;
  } catch (error) {
    console.error('Error loading costs config from Supabase:', error);
    return null;
  }
};

export const saveCostsConfigToSupabase = async (config: CostsConfig): Promise<boolean> => {
  try {
    const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/costs-config`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ settings_json: config }),
    });

    if (!response.ok) {
      console.error('Failed to save costs config to Supabase:', response.statusText);
      return false;
    }

    const result = await response.json();
    return result.success === true;
  } catch (error) {
    console.error('Error saving costs config to Supabase:', error);
    return false;
  }
};

const migrateOldConfig = (): CostsConfig | null => {
  try {
    const oldBoards = localStorage.getItem('costs-board-assignments');
    const oldSliders = localStorage.getItem('costs-slider-values');
    const oldAdjustments = localStorage.getItem('costs-adjustment-percents');
    const oldNotes = localStorage.getItem('costs-notes');
    const oldExcluded = localStorage.getItem('costs-excluded-items');

    if (!oldBoards && !oldSliders && !oldAdjustments && !oldExcluded) {
      return null;
    }

    const config: CostsConfig = {
      schemaVersion: 1,
      boards: oldBoards ? JSON.parse(oldBoards) : {},
      sliders: oldSliders ? JSON.parse(oldSliders) : {},
      adjustments: {},
      excluded: {},
      updatedAt: new Date().toISOString(),
    };

    if (oldAdjustments) {
      const adjustPercentMap = JSON.parse(oldAdjustments);
      const notesMap = oldNotes ? JSON.parse(oldNotes) : {};

      Object.keys(adjustPercentMap).forEach((itemName) => {
        config.adjustments[itemName] = {
          percent: adjustPercentMap[itemName],
          note: notesMap[itemName] || '',
        };
      });
    }

    if (oldExcluded) {
      const excludedMap = JSON.parse(oldExcluded);
      Object.keys(excludedMap).forEach((itemName) => {
        config.excluded[itemName] = true;
      });
    }

    console.log('Migrated old costs config to v1:', config);
    return config;
  } catch (error) {
    console.error('Error migrating old config:', error);
    return null;
  }
};

export const computeCostsSnapshot = (
  xeroData: XeroData | null,
  dateRange: DateRange
): CostsSnapshot => {
  const emptySnapshot: CostsSnapshot = {
    dateRange: {
      from: new Date().toISOString(),
      to: new Date().toISOString(),
    },
    totals: {
      fixed: { b2c: 0, b2b: 0 },
      variable: { b2c: 0, b2b: 0 },
      andrea: { b2c: 0, b2b: 0 },
    },
    items: [],
  };

  if (!xeroData || !dateRange.from || !dateRange.to) {
    return emptySnapshot;
  }

  try {
    const config = loadCostsConfig();

    const assignments = config.boards;
    const sliders = config.sliders;
    const adjustments: Record<string, number> = {};
    Object.keys(config.adjustments).forEach((itemName) => {
      adjustments[itemName] = config.adjustments[itemName].percent;
    });
    const excludedSet = new Set(Object.keys(config.excluded));

    const itemsWithBoard: CostItemWithBoard[] = xeroData.items
      .filter((item) => !excludedSet.has(item.name))
      .map((item) => ({
        ...item,
        board: assignments[item.name] || 'fixed',
        sliderValue: sliders[item.name] !== undefined ? sliders[item.name] : 50,
        adjustmentPercent: adjustments[item.name] !== undefined ? adjustments[item.name] : 100,
      }));

    const totals: CostsSnapshot['totals'] = {
      fixed: { b2c: 0, b2b: 0 },
      variable: { b2c: 0, b2b: 0 },
      andrea: { b2c: 0, b2b: 0 },
    };

    const items: CostsSnapshotItem[] = [];

    itemsWithBoard.forEach((item) => {
      if (item.board === 'pool') return;

      const amount = calculateItemAmount(item, xeroData.months, dateRange, xeroData.periodEnd);
      const b2cPercent = (100 - item.sliderValue) / 100;
      const b2bPercent = item.sliderValue / 100;
      const b2cAmount = amount * b2cPercent;
      const b2bAmount = amount * b2bPercent;

      totals[item.board].b2c += b2cAmount;
      totals[item.board].b2b += b2bAmount;

      items.push({
        name: item.name,
        board: item.board,
        adjustedAmount: amount,
        b2cAmount,
        b2bAmount,
      });
    });

    return {
      dateRange: {
        from: dateRange.from.toISOString(),
        to: dateRange.to.toISOString(),
      },
      totals,
      items,
    };
  } catch (error) {
    console.error('Error computing costs snapshot:', error);
    return emptySnapshot;
  }
};
