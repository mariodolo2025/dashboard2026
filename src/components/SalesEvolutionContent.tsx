import React, { useState, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { format, startOfWeek, addWeeks, startOfDay, addDays, startOfMonth, addMonths } from 'date-fns';

interface UnleashedRow {
  orderDate: Date | null;
  product: string;
  customer: string;
  quantity: number;
  subTotal: number;
  productGroup: string;
  channel: string;
  brand: string;
  warehouse: string;
  status: string;
}

interface ShopifyRow {
  date: Date;
  netSales: number;
  sku: string;
  quantity: number;
  region: string;
  taxes: number;
  shipping: number;
}

interface OldShopifyRow {
  date: Date;
  netSales: number;
  region: string;
}

interface SalesEvolutionContentProps {
  unleashedData: UnleashedRow[];
  shopifyData: ShopifyRow[];
  oldShopifyData: OldShopifyRow[];
  startDate: Date;
  endDate: Date;
}

interface B2BOption {
  id: string;
  label: string;
  brands?: string[];
}

interface ShopifyOption {
  id: string;
  label: string;
  region: string;
}

const b2bOptions: B2BOption[] = [
  { id: 'all-b2b', label: 'All B2B' },
  { id: 'pesado', label: 'Pesado', brands: ['PESADO'] },
  { id: 'artisan-barista', label: 'The Artisan Barista', brands: ['The Artisan Barista'] },
  { id: 'coffee-accessories', label: 'Coffee Accessories', brands: ['Coffee Accessories'] },
  { id: 'dolo', label: 'Dolo', brands: ['BWT', 'Cafetto', 'Aeropress', 'DiFluid', 'Fellow', 'Hario', 'IMS', 'Rhinoware', 'Tamp-M'] },
  { id: 'wpm', label: 'WPM', brands: ['WPM', 'WPM parts'] },
  { id: 'tiamo', label: 'Tiamo', brands: ['Tiamo', 'Tiamo Cold Drip'] }
];

const shopifyOptions: ShopifyOption[] = [
  { id: 'shopify-usa', label: 'Shopify USA', region: 'USA' },
  { id: 'shopify-australia', label: 'Shopify Australia', region: 'Australia' },
  { id: 'shopify-rest-of-world', label: 'Shopify Rest of the World', region: 'Other' },
  { id: 'shopify-total', label: 'Shopify Total', region: 'TOTAL' }
];

// Linear regression calculation
const calculateLinearRegression = (points: { x: number; y: number }[]): { slope: number; intercept: number } => {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0 };

  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.y, 0);
  const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
};

const colors = [
  '#8884d8', '#82ca9d', '#ffc658', '#ff7300', '#00ff00', 
  '#ff00ff', '#00ffff', '#ff0000', '#0000ff'
];

export default function SalesEvolutionContent({ 
  unleashedData, 
  shopifyData, 
  oldShopifyData, 
  startDate, 
  endDate 
}: SalesEvolutionContentProps) {
  const [selectedB2B, setSelectedB2B] = useState<string[]>(['all-b2b']);
  const [selectedShopify, setSelectedShopify] = useState<string[]>([]);
  const [showTrendLine, setShowTrendLine] = useState<boolean>(false);
  const [timeScale, setTimeScale] = useState<'days' | 'weeks' | 'months'>('weeks');

  // Add diagnostics for date range
  console.log('SalesEvolutionContent received dates:', { startDate, endDate });
  console.log('Data counts:', { 
    unleashed: unleashedData.length, 
    shopify: shopifyData.length, 
    oldShopify: oldShopifyData.length 
  });

  // Move getSelectedLabels function definition before useMemo
  const getSelectedLabels = (): string[] => {
    const b2bLabels = selectedB2B.map(id => b2bOptions.find(opt => opt.id === id)?.label).filter((label): label is string => Boolean(label));
    const shopifyLabels = selectedShopify.map(id => shopifyOptions.find(opt => opt.id === id)?.label).filter((label): label is string => Boolean(label));
    return [...b2bLabels, ...shopifyLabels];
  };

  const timeSeriesData = useMemo(() => {
    const timeSeries = new Map<string, any>();
    
    // Initialize time periods based on selected scale
    let currentPeriod: Date;
    let keyFormat: string;
    let labelFormat: string;
    let addPeriod: (date: Date, amount: number) => Date;
    let startOfPeriod: (date: Date) => Date;

    switch (timeScale) {
      case 'days':
        currentPeriod = startOfDay(startDate);
        keyFormat = 'yyyy-MM-dd';
        labelFormat = 'MMM dd';
        addPeriod = addDays;
        startOfPeriod = startOfDay;
        break;
      case 'months':
        currentPeriod = startOfMonth(startDate);
        keyFormat = 'yyyy-MM';
        labelFormat = 'MMM yyyy';
        addPeriod = addMonths;
        startOfPeriod = startOfMonth;
        break;
      case 'weeks':
      default:
        currentPeriod = startOfWeek(startDate, { weekStartsOn: 1 });
        keyFormat = 'yyyy-MM-dd';
        labelFormat = 'MMM dd';
        addPeriod = addWeeks;
        startOfPeriod = (date: Date) => startOfWeek(date, { weekStartsOn: 1 });
        break;
    }

    console.log('Initializing time series from:', currentPeriod, 'to:', endDate, 'scale:', timeScale);
    while (currentPeriod <= endDate) {
      const periodKey = format(currentPeriod, keyFormat);
      timeSeries.set(periodKey, { 
        period: periodKey, 
        label: format(currentPeriod, labelFormat) 
      });
      currentPeriod = addPeriod(currentPeriod, 1);
    }
    console.log('Total periods initialized:', timeSeries.size);

    // Process B2B data (Unleashed)
    selectedB2B.forEach((optionId) => {
      const option = b2bOptions.find(opt => opt.id === optionId);
      if (!option) return;

      const filteredData = unleashedData.filter(row => {
        if (!row.orderDate || row.channel !== 'B2B') return false;
        if (row.orderDate < startDate || row.orderDate > endDate) return false;
        
        if (option.id === 'all-b2b') return true;
        if (option.brands) {
          return option.brands.includes(row.productGroup);
        }
        return false;
      });

      filteredData.forEach(row => {
        if (row.orderDate) {
          const periodStart = startOfPeriod(row.orderDate);
          const periodKey = format(periodStart, keyFormat);
          
          if (timeSeries.has(periodKey)) {
            const periodData = timeSeries.get(periodKey);
            periodData[option.label] = (periodData[option.label] || 0) + row.subTotal;
          }
        }
      });
    });

    // Process Shopify data
    selectedShopify.forEach((optionId) => {
      const option = shopifyOptions.find(opt => opt.id === optionId);
      if (!option) return;

      let filteredShopifyData: ShopifyRow[];
      let filteredOldShopifyData: OldShopifyRow[];

      if (option.id === 'shopify-total') {
        // For Shopify Total, include all regions
        filteredShopifyData = shopifyData.filter(row => {
          return row.date >= startDate && row.date <= endDate;
        });
        
        filteredOldShopifyData = oldShopifyData.filter(row => {
          return row.date >= startDate && row.date <= endDate;
        });
      } else {
        // For specific regions, filter by region
        filteredShopifyData = shopifyData.filter(row => {
          if (row.date < startDate || row.date > endDate) return false;
          return row.region === option.region;
        });
        
        filteredOldShopifyData = oldShopifyData.filter(row => {
          if (row.date < startDate || row.date > endDate) return false;
          return row.region === option.region;
        });
      }

      filteredShopifyData.forEach(row => {
        const periodStart = startOfPeriod(row.date);
        const periodKey = format(periodStart, keyFormat);
        
        if (timeSeries.has(periodKey)) {
          const periodData = timeSeries.get(periodKey);
          periodData[option.label] = (periodData[option.label] || 0) + row.netSales;
        }
      });

      filteredOldShopifyData.forEach(row => {
        const periodStart = startOfPeriod(row.date);
        const periodKey = format(periodStart, keyFormat);
        
        if (timeSeries.has(periodKey)) {
          const periodData = timeSeries.get(periodKey);
          periodData[option.label] = (periodData[option.label] || 0) + row.netSales;
        }
      });
    });

    // Calculate trend lines if enabled
    const timeSeriesDataArray = Array.from(timeSeries.values()).sort((a, b) => a.period.localeCompare(b.period));
    
    console.log('Time series data array length:', timeSeriesDataArray.length);
    console.log('Sample time series data:', timeSeriesDataArray.slice(0, 3));
    
    if (showTrendLine) {
      const selectedLabels = getSelectedLabels();
      
      selectedLabels.forEach(label => {
        const points = timeSeriesDataArray.map((periodData, idx) => {
          const value = (periodData as Record<string, any>)[label];
          return {
            x: idx,
            y: typeof value === 'number' ? value : 0
          };
        });

        const { slope, intercept } = calculateLinearRegression(points);

        timeSeriesDataArray.forEach((periodData, index) => {
          (periodData as Record<string, any>)[`Trend ${label}`] = slope * index + intercept;
        });
      });
    }

    return timeSeriesDataArray;
  }, [unleashedData, shopifyData, oldShopifyData, selectedB2B, selectedShopify, startDate, endDate, showTrendLine, timeScale]);

  const handleB2BChange = (optionId: string, checked: boolean) => {
    if (checked) {
      setSelectedB2B(prev => [...prev, optionId]);
    } else {
      setSelectedB2B(prev => prev.filter(id => id !== optionId));
    }
  };

  const handleShopifyChange = (optionId: string, checked: boolean) => {
    if (checked) {
      setSelectedShopify(prev => [...prev, optionId]);
    } else {
      setSelectedShopify(prev => prev.filter(id => id !== optionId));
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>B2B Channels</CardTitle>
            <CardDescription>Select B2B channels and brands to display</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {b2bOptions.map((option) => (
              <div key={option.id} className="flex items-center space-x-2">
                <Checkbox
                  id={option.id}
                  checked={selectedB2B.includes(option.id)}
                  onCheckedChange={(checked) => handleB2BChange(option.id, checked as boolean)}
                />
                <label htmlFor={option.id} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  {option.label}
                </label>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Shopify Regions</CardTitle>
            <CardDescription>Select Shopify regions to display</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {shopifyOptions.map((option) => (
              <div key={option.id} className="flex items-center space-x-2">
                <Checkbox
                  id={option.id}
                  checked={selectedShopify.includes(option.id)}
                  onCheckedChange={(checked) => handleShopifyChange(option.id, checked as boolean)}
                />
                <label htmlFor={option.id} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  {option.label}
                </label>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Chart Options</CardTitle>
          <CardDescription>Configure chart display options</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="show-trend-line"
              checked={showTrendLine}
              onCheckedChange={(checked) => setShowTrendLine(checked as boolean)}
            />
            <label htmlFor="show-trend-line" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
              Show Trend Lines
            </label>
          </div>
          <div className="mt-4">
            <label htmlFor="time-scale" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 mb-2 block">
              Time Scale
            </label>
            <Select value={timeScale} onValueChange={(value: 'days' | 'weeks' | 'months') => setTimeScale(value)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="days">Days</SelectItem>
                <SelectItem value="weeks">Weeks</SelectItem>
                <SelectItem value="months">Months</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sales Evolution</CardTitle>
          <CardDescription>
            {timeScale === 'days' ? 'Daily' : timeScale === 'weeks' ? 'Weekly' : 'Monthly'} sales trends by channel and region
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timeSeriesData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="label" 
                  tick={{ fontSize: 12 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis 
                  tick={{ fontSize: 12 }}
                  tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
                />
                <Tooltip 
                  formatter={(value: number, name: string) => {
                    const displayName = name.startsWith('Trend ') 
                      ? `Trend (${name.replace('Trend ', '')})`
                      : name;
                    return [`$${value.toLocaleString()}`, displayName];
                  }}
                  labelFormatter={(label) => {
                    const prefix = timeScale === 'days' ? 'Day of' : timeScale === 'weeks' ? 'Week of' : 'Month of';
                    return `${prefix} ${label}`;
                  }}
                />
                <Legend />
                {getSelectedLabels().map((label, index) => (
                  <React.Fragment key={label}>
                    <Line
                      type="monotone"
                      dataKey={label}
                      stroke={colors[index % colors.length]}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      connectNulls={false}
                    />
                    {showTrendLine && (
                      <Line
                        type="monotone"
                        dataKey={`Trend ${label}`}
                        stroke={colors[index % colors.length]}
                        strokeWidth={1}
                        strokeDasharray="5 5"
                        dot={false}
                        connectNulls={false}
                      />
                    )}
                  </React.Fragment>
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}