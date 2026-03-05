# Economic Dashboard

A React + TypeScript dashboard for analyzing sales data from multiple sources (Unleashed, Shopify, Meta Ads, etc.) with Supabase integration for centralized data management.

## Features

- **Multi-source Data Analysis**: Processes data from Unleashed, Shopify, Meta Ads, and cost files
- **Automated Data Loading**: Uses Supabase Storage and Edge Functions to centralize CSV files
- **Real-time Currency Conversion**: Automatic USD to AUD conversion with live exchange rates
- **Channel Analysis**: Revenue breakdown by sales channels (B2B, Shopify, Korea, etc.)
- **Weekly ROAS Tracking**: Return on Ad Spend calculations with target visualization
- **Top SKU Analysis**: Product performance with margin calculations
- **Warehouse Filtering**: Filter data by specific warehouses

## Setup

### 1. Supabase Configuration

1. Create a new Supabase project
2. Run the migration to set up storage:
   ```sql
   -- This will be automatically applied from supabase/migrations/
   ```

3. Upload your CSV files to the `csv-files` bucket with these exact names:
   - `unleashed-sales.csv`
   - `shopify-sales.csv`
   - `old-shopify-sales.csv`
   - `meta-ads.csv`
   - `costs.csv`

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in your Supabase credentials:

```bash
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run Development Server

```bash
npm run dev
```

## Data Sources

### Unleashed Sales
- **Format**: CSV with auto-detected headers
- **Key Columns**: Order Date, Product Code, Customer, Quantity, Sub Total, Warehouse
- **Processing**: Automatically categorizes customers into channels (B2B, Shopify, Korea, etc.)

### Shopify Sales (Current)
- **Format**: CSV with fixed column positions
- **Key Columns**: C=SKU, F=Date, G=Quantity, K=Net Sales (USD)
- **Processing**: Converts USD to AUD using live exchange rates

### Old Shopify Sales (2025)
- **Format**: CSV with fixed column positions  
- **Key Columns**: D=Date, I=Net Sales (AUD)
- **Processing**: Already in AUD, no conversion needed

### Meta Ads
- **Format**: CSV with headers
- **Key Columns**: Date, Amount Spent, Currency
- **Processing**: Converts USD to AUD, aggregates by week for ROAS calculation

### Costs
- **Format**: CSV with SKU and unit cost
- **Key Columns**: SKU, Unit Cost
- **Processing**: Creates lookup table for margin calculations

## Key Calculations

### Channel Analysis
- Combines Shopify data from both current and historical files
- Excludes Shopify/Shop sale/Unclassified channels from Unleashed data
- Calculates revenue share percentages

### Weekly ROAS
- **Formula**: (Total Shopify Sales) / (Total Meta Ad Spend) per week
- Uses Monday as week start
- Supports target ROAS visualization

### Top SKU Analysis
- Combines data from Unleashed (B2B/Korea) and Shopify
- Calculates margins using cost data: `((Revenue - (Unit Cost × Units)) / Revenue) × 100`
- Supports filtering by channel and sorting by revenue/units

## Architecture

### Frontend (React + TypeScript)
- **State Management**: React hooks for data and UI state
- **UI Components**: shadcn/ui component library
- **Charts**: Recharts for ROAS visualization
- **Date Handling**: date-fns for date parsing and formatting

### Backend (Supabase)
- **Storage**: CSV files stored in `csv-files` bucket
- **Edge Functions**: Server-side CSV parsing and data processing
- **Real-time**: Automatic data updates with single button click

### Data Flow
1. CSV files uploaded to Supabase Storage (manual admin process)
2. User clicks "Update" button in dashboard
3. Edge Function downloads and parses all CSV files
4. Processed data returned as JSON to frontend
5. Dashboard updates with new calculations and visualizations

## Manual File Upload Fallback

The application includes legacy file upload inputs as a fallback option. These are hidden by default but can be accessed through the "Manual File Upload (Fallback)" section in the sidebar.

## Development

### Adding New Data Sources
1. Add parsing logic to the Edge Function (`supabase/functions/parse-csv-data/index.ts`)
2. Update the `DataResponse` interface
3. Add corresponding state management in `App.tsx`
4. Update calculations and visualizations as needed

### Modifying Calculations
- Channel analysis logic is in the `channelAnalysis` useMemo hook
- ROAS calculations are in the `weeklyROAS` useMemo hook  
- SKU analysis is in the `topSKUs` useMemo hook

## Deployment

The application can be deployed to any static hosting service. Make sure to:
1. Set up your Supabase project and upload CSV files
2. Configure environment variables
3. Deploy the Edge Function to Supabase
4. Build and deploy the frontend

```bash
npm run build
```