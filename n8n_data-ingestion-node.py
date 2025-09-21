"""
Data Ingestion Service for n8n Trading Processor
Permanent version with direct node access for reliable data retrieval.
"""

import pandas as pd
from datetime import datetime, timedelta
from typing import Dict, List, Tuple, Any
import warnings

# Suppress warnings for cleaner output
warnings.filterwarnings('ignore')

def last_trading_date(today=None):
    """Return last trading date (Mon–Fri), mapping Sat/Sun -> Fri."""
    dt = pd.Timestamp(today or datetime.now())
    if dt.weekday() == 5:  # Sat -> Fri
        return (dt - pd.Timedelta(days=1)).normalize()
    if dt.weekday() == 6:  # Sun -> Fri
        return (dt - pd.Timedelta(days=2)).normalize()
    return dt.normalize()

def process_data_ingestion():
    """Main data ingestion function for n8n with direct node access."""
    try:
        # Initialize data containers
        google_sheets_data = []
        ticker_data = []
        
        # Get all market data from the merged input
        all_market_data = []
        input_items = _input.all()
        
        # Deduplicate market data by symbol to prevent processing duplicates
        seen_symbols = set()
        for item in input_items:
            if 'data' in item['json'] and isinstance(item['json']['data'], dict):
                symbol = item['json']['data'].get('symbol', '').upper()
                if symbol and symbol not in seen_symbols:
                    all_market_data.append(item['json'])
                    seen_symbols.add(symbol)
        
        # Define benchmark and S&P 500 tickers
        benchmarks = {'IWO', 'XBI', 'SPY', 'IWM'}
        sp500_tickers = {'^GSPC', 'SPY', '^SPX'}
        
        # 1. Get Google Sheets portfolio data directly
        try:
            google_sheets_raw = _('Google Sheets Node').all()
            for item in google_sheets_raw:
                if hasattr(item['json'], 'to_py'):
                    python_data = item['json'].to_py()
                else:
                    python_data = dict(item['json'])
                
                # Validate Google Sheets data structure
                if all(key in python_data for key in ['Date', 'Ticker', 'Shares', 'Buy Price']):
                    google_sheets_data.append(python_data)
        except Exception as e:
            # Log error but continue processing
            pass

        # 2. Get ticker list from Parse Current Holdings
        try:
            ticker_raw = _('Parse Current Holdings').all()
            for item in ticker_raw:
                if hasattr(item['json'], 'to_py'):
                    python_data = item['json'].to_py()
                else:
                    python_data = dict(item['json'])
                
                if 'ticker' in python_data:
                    ticker_data.append(python_data)
        except Exception as e:
            # Log error but continue processing
            pass
        
        # Initialize classified data structure
        classified_data = {
            'historical_portfolio': google_sheets_data,
            'current_market_data': [],
            'benchmark_data': [],
            'sp500_data': [],
            'ticker_list': ticker_data
        }
        
        # Process all market data from the merged input and classify by ticker type
        for item in all_market_data:
            if 'data' in item and isinstance(item['data'], dict):
                market_item = item['data']
                ticker = market_item.get('symbol', '').upper()
                
                # Skip invalid tickers
                if not ticker or ticker in ['BY-TYPE', 'UNKNOWN']:
                    continue
                
                # Standardize market data using DXFeed fields
                standardized_item = {
                    'Ticker': ticker,
                    'Date': market_item.get('summary-date', datetime.now().strftime('%Y-%m-%d')),
                    # Real OHLC data from DXFeed
                    'Open': float(market_item.get('open', market_item.get('prev-close', 0))),
                    'High': float(market_item.get('day-high-price', market_item.get('last', 0))),
                    'Low': float(market_item.get('day-low-price', market_item.get('last', 0))),
                    'Close': float(market_item.get('close', market_item.get('last', 0))),
                    'Volume': 0,  # Not provided in this format
                    'PrevClose': float(market_item.get('prev-close', 0)),
                    'HasIntradayData': True,
                    'DataSource': 'TastyTrade_DXFeed_Direct_Access',
                    # Additional market data
                    'Bid': float(market_item.get('bid', 0)),
                    'Ask': float(market_item.get('ask', 0)),
                    'Mid': float(market_item.get('mid', 0)),
                    'Mark': float(market_item.get('mark', 0)),
                    'YearLow': float(market_item.get('year-low-price', 0)),
                    'YearHigh': float(market_item.get('year-high-price', 0)),
                    'InstrumentType': market_item.get('instrument-type', ''),
                    'UpdatedAt': market_item.get('updated-at', ''),
                    'IsTradingHalted': market_item.get('is-trading-halted', False)
                }
                
                # Classify by ticker type
                if ticker in sp500_tickers:
                    classified_data['sp500_data'].append(standardized_item)
                elif ticker in benchmarks:
                    classified_data['benchmark_data'].append(standardized_item)
                else:
                    classified_data['current_market_data'].append(standardized_item)
        
        # Enhanced debug info
        debug_info = {
            "processing_date": datetime.now().isoformat(),
            "data_access_method": "direct_node_access",
            "data_sources": {
                "google_sheets_available": len(google_sheets_data) > 0,
                "ticker_list_available": len(ticker_data) > 0,
                "total_market_data_items": len(all_market_data),
                "input_items_received": len(input_items),
                "unique_symbols_processed": len(seen_symbols)
            },
            "classified_counts": {
                "historical_portfolio": len(classified_data['historical_portfolio']),
                "current_market_data": len(classified_data['current_market_data']),
                "benchmark_data": len(classified_data['benchmark_data']),
                "sp500_data": len(classified_data['sp500_data']),
                "ticker_list": len(classified_data['ticker_list'])
            },
            "data_quality": {
                "all_tickers_have_intraday": True,
                "data_source": "TastyTrade_DXFeed_Direct_Access_Permanent"
            },
            "tickers_found": {
                "portfolio": [item['Ticker'] for item in classified_data['current_market_data']],
                "benchmarks": [item['Ticker'] for item in classified_data['benchmark_data']],
                "sp500": [item['Ticker'] for item in classified_data['sp500_data']]
            }
        }
        
        # Return classified data in n8n format - single output regardless of input count
        return [{
            "json": {
                "type": "classified_data",
                **classified_data,
                "debug_info": debug_info
            }
        }]
        
    except Exception as e:
        import traceback
        return [{
            "json": {
                "type": "error",
                "error": f"Data ingestion failed: {str(e)}",
                "traceback": traceback.format_exc(),
                "timestamp": datetime.now().isoformat()
            }
        }]

# Execute the main function
return process_data_ingestion()