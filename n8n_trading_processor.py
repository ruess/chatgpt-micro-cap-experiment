"""
n8n Trading Portfolio Processor

Simplified version of the trading script designed specifically for n8n integration.
Accepts data from upstream nodes and returns processed portfolio updates.
"""

import pandas as pd
import numpy as np
import json
from datetime import datetime, timedelta
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

def process_trading_portfolio():
    try:
        # Get all input data
        all_input_data = [item.json for item in _input.all()]
        
        
        if not all_input_data:
            return [{"json": {"error": "No input data received from any source"}}]
        
        # Separate the different types of data based on their structure
        historical_portfolio = []
        current_market_data = []
        benchmark_data = []
        sp500_data = []
        
        # Debug info to see what we're receiving
        input_analysis = []
        
        for i, item in enumerate(all_input_data):
            item_info = {
                "item_index": i,
                "keys": list(item.keys()),
                "sample_data": {}
            }
            
            # Better sample data representation
            for k, v in item.items():
                if isinstance(v, dict):
                    item_info["sample_data"][k] = f"Dict with keys: {list(v.keys())}"
                elif isinstance(v, list):
                    item_info["sample_data"][k] = f"List with {len(v)} items"
                else:
                    item_info["sample_data"][k] = str(v)[:100]
            
            # Check if this is Google Sheets portfolio data
            # Your data has: row_number, Date, Ticker, Shares, Buy Price, Cost Basis, Stop Loss, etc.
            if 'row_number' in item and 'Date' in item and 'Ticker' in item and 'Shares' in item:
                historical_portfolio.append(item)
                item_info["identified_as"] = "Google Sheets Portfolio Data"
            
            # Also check for the alternative format without row_number
            elif 'Date' in item and 'Ticker' in item and 'Shares' in item and 'Buy Price' in item:
                historical_portfolio.append(item)
                item_info["identified_as"] = "Google Sheets Portfolio Data (alt format)"
            
            # Check if this is market data from API
            elif 'data' in item and isinstance(item['data'], dict):
                market_item = item['data']
                
                # Check if it has the expected market data structure
                if 'symbol' in market_item and ('last' in market_item or 'mark' in market_item):
                    # Extract ticker symbol
                    ticker = (market_item.get('symbol') or market_item.get('Ticker') or market_item.get('ticker', '')).upper()
                    
                    if ticker:
                        # Convert to standard OHLCV format using available fields
                        standardized_item = {
                            'Ticker': ticker,
                            'Date': market_item.get('summary-date', datetime.now().strftime('%Y-%m-%d')),
                            'Open': float(market_item.get('prev-close', market_item.get('last', 0))),
                            'High': float(market_item.get('year-high-price', market_item.get('last', 0))),
                            'Low': float(market_item.get('year-low-price', market_item.get('last', 0))),
                            'Close': float(market_item.get('last', market_item.get('mark', 0))),
                            'Volume': 0,  # Not available in this data format
                            'Bid': float(market_item.get('bid', 0)),
                            'Ask': float(market_item.get('ask', 0)),
                            'Mid': float(market_item.get('mid', 0))
                        }
                        
                        # Categorize by ticker type
                        benchmarks = {'IWO', 'XBI', 'SPY', 'IWM'}
                        sp500_tickers = {'^GSPC', 'SPY', '^SPX'}
                        
                        if ticker in sp500_tickers:
                            sp500_data.append(standardized_item)
                            item_info["identified_as"] = "S&P 500 Market Data"
                        elif ticker in benchmarks:
                            benchmark_data.append(standardized_item)
                            item_info["identified_as"] = "Benchmark Market Data"
                        else:
                            current_market_data.append(standardized_item)
                            item_info["identified_as"] = "Portfolio Market Data"
                    else:
                        item_info["identified_as"] = "Market Data (no ticker found)"
                else:
                    item_info["identified_as"] = "Data object (not market data)"
            
            # Check for other possible data structures
            elif 'ticker' in item:
                item_info["identified_as"] = "Ticker Data (from extraction node)"
            else:
                item_info["identified_as"] = "Unknown Data Structure"
            
            input_analysis.append(item_info)
        
        # Enhanced debug info
        debug_info = {
            "total_input_items": len(all_input_data),
            "input_analysis": input_analysis[:5],  # Show first 5 items for brevity
            "historical_portfolio_count": len(historical_portfolio),
            "current_market_data_count": len(current_market_data),
            "benchmark_data_count": len(benchmark_data),
            "sp500_data_count": len(sp500_data)
        }
        
        # Data summary
        data_summary = {
            "historical_portfolio_count": len(historical_portfolio),
            "current_market_data_count": len(current_market_data),
            "benchmark_data_count": len(benchmark_data),
            "sp500_data_count": len(sp500_data),
            "market_tickers_found": [item['Ticker'] for item in current_market_data] if current_market_data else []
        }
        
        # Check if we have the required data
        if not historical_portfolio:
            return [{"json": {
                "error": "No Google Sheets portfolio data found in input",
                "debug_info": debug_info,
                "data_summary": data_summary,
                "help": "Make sure the Google Sheets data is being passed to this node with Date, Ticker, Shares columns",
                "first_few_items": all_input_data[:3] if len(all_input_data) >= 3 else all_input_data
            }}]
        
        # Convert historical portfolio to DataFrame
        hist_df = pd.DataFrame(historical_portfolio)
        
        # Clean up the data - remove row_number column if present
        if 'row_number' in hist_df.columns:
            hist_df = hist_df.drop('row_number', axis=1)
        
        # Extract current portfolio state
        current_portfolio, cash_balance = extract_current_portfolio(hist_df)
        
        # Process market data into the format expected by portfolio processing
        market_data_dict = {}
        for item in current_market_data:
            ticker = item['Ticker']
            
            # Create DataFrame with the market data
            df_data = {
                'Open': [item['Open']],
                'High': [item['High']], 
                'Low': [item['Low']],
                'Close': [item['Close']],
                'Volume': [item.get('Volume', 0)],
                'Date': [item['Date']]
            }
            df = pd.DataFrame(df_data)
            df['Date'] = pd.to_datetime(df['Date'])
            df = df.set_index('Date')
            market_data_dict[ticker] = df
        
        # If no external market data for some tickers, use historical prices from Google Sheets
        if current_portfolio is not None and not current_portfolio.empty:
            for _, position in current_portfolio.iterrows():
                ticker = str(position["ticker"]).upper()
                if ticker not in market_data_dict:
                    # Try to find this ticker in historical data
                    ticker_hist = hist_df[hist_df['Ticker'] == ticker]
                    if not ticker_hist.empty and 'Current Price' in ticker_hist.columns:
                        latest_price = ticker_hist['Current Price'].iloc[-1]
                        if pd.notna(latest_price) and latest_price != "":
                            current_price = float(latest_price)
                            df_data = {
                                'Open': [current_price],
                                'High': [current_price], 
                                'Low': [current_price],
                                'Close': [current_price],
                                'Volume': [0],
                                'Date': [datetime.now().strftime('%Y-%m-%d')]
                            }
                            df = pd.DataFrame(df_data)
                            df['Date'] = pd.to_datetime(df['Date'])
                            df = df.set_index('Date')
                            market_data_dict[ticker] = df
        
        # Process portfolio positions
        updated_portfolio, final_cash, portfolio_results = process_portfolio_positions(
            current_portfolio, cash_balance, market_data_dict
        )
        
        # Combine all market data for performance metrics
        all_market_dict = market_data_dict.copy()
        
        # Add benchmark data if available
        for item in benchmark_data:
            ticker = item['Ticker']
            df_data = {
                'Open': [item['Open']],
                'High': [item['High']], 
                'Low': [item['Low']],
                'Close': [item['Close']],
                'Volume': [item.get('Volume', 0)],
                'Date': [item['Date']]
            }
            df = pd.DataFrame(df_data)
            df['Date'] = pd.to_datetime(df['Date'])
            df = df.set_index('Date')
            all_market_dict[ticker] = df
        
        # Process S&P 500 data
        sp500_df = pd.DataFrame()
        if sp500_data:
            sp500_df = pd.DataFrame(sp500_data)
            if 'Date' in sp500_df.columns:
                sp500_df['Date'] = pd.to_datetime(sp500_df['Date'])
                sp500_df = sp500_df.set_index('Date').sort_index()
        
        # Calculate performance metrics
        performance_metrics = calculate_performance_metrics(
            hist_df,
            portfolio_results, 
            all_market_dict,
            sp500_df,
            10000.0  # Default starting equity
        )
        
        # Return results in proper n8n format
        results = []
        
        # Add each portfolio update as a separate item
        for update in portfolio_results:
            results.append({"json": {"type": "portfolio_update", **update}})
        
        # Add performance metrics as a separate item
        results.append({"json": {"type": "performance_metrics", **performance_metrics}})
        
        # Add updated portfolio state
        if not updated_portfolio.empty:
            for _, row in updated_portfolio.iterrows():
                results.append({"json": {"type": "portfolio_state", **row.to_dict()}})
        
        # Add summary item with debug info
        results.append({"json": {
            "type": "summary",
            "portfolio_updates_count": len(portfolio_results),
            "final_cash_balance": final_cash,
            "processing_date": datetime.now().isoformat(),
            "debug_info": debug_info,
            "data_summary": data_summary,
            "market_data_tickers": list(market_data_dict.keys()),
            "success": True
        }})
        
        return results
        
    except Exception as e:
        import traceback
        return [{"json": {
            "error": f"Processing failed: {str(e)}", 
            "type": "error",
            "traceback": traceback.format_exc(),
            "input_data_available": len(all_input_data) if 'all_input_data' in locals() else 0
        }}]

def extract_current_portfolio(historical_df):
    """Extract current portfolio state from historical data."""
    if historical_df.empty:
        return pd.DataFrame(columns=["ticker", "shares", "stop_loss", "buy_price", "cost_basis"]), 10000.0
    
    # Get non-TOTAL rows for the latest date
    non_total = historical_df[historical_df["Ticker"] != "TOTAL"].copy()
    if non_total.empty:
        return pd.DataFrame(columns=["ticker", "shares", "stop_loss", "buy_price", "cost_basis"]), 10000.0
    
    non_total["Date"] = pd.to_datetime(non_total["Date"], errors='coerce')
    latest_date = non_total["Date"].max()
    latest_holdings = non_total[non_total["Date"] == latest_date].copy()
    
    # Remove sold positions
    if 'Action' in latest_holdings.columns:
        sold_mask = latest_holdings["Action"].astype(str).str.startswith("SELL")
        current_holdings = latest_holdings[~sold_mask].copy()
    else:
        current_holdings = latest_holdings.copy()
    
    # Format for processing - handle the actual column names from your Google Sheet
    column_mapping = {
        "Ticker": "ticker",
        "Shares": "shares", 
        "Buy Price": "buy_price",
        "Cost Basis": "cost_basis",
        "Stop Loss": "stop_loss"
    }
    
    # Rename columns that exist
    existing_columns = [col for col in column_mapping.keys() if col in current_holdings.columns]
    portfolio = current_holdings[existing_columns].rename(columns=column_mapping)
    
    # Ensure all required columns exist
    required_columns = ["ticker", "shares", "buy_price", "cost_basis", "stop_loss"]
    for col in required_columns:
        if col not in portfolio.columns:
            portfolio[col] = 0.0 if col != "ticker" else ""
    
    portfolio = portfolio[required_columns]
    
    # Get current cash balance from TOTAL rows
    total_rows = historical_df[historical_df["Ticker"] == "TOTAL"].copy()
    if not total_rows.empty and 'Cash Balance' in total_rows.columns:
        total_rows["Date"] = pd.to_datetime(total_rows["Date"], errors='coerce')
        latest_total = total_rows.sort_values("Date").iloc[-1]
        cash = float(latest_total["Cash Balance"]) if pd.notna(latest_total["Cash Balance"]) and latest_total["Cash Balance"] != "" else 10000.0
    else:
        # Estimate cash from total equity minus current positions value
        if not current_holdings.empty and 'Total Value' in current_holdings.columns:
            total_position_value = current_holdings['Total Value'].sum()
            cash = max(0, 10000.0 - total_position_value)  # Rough estimate
        else:
            cash = 10000.0
    
    return portfolio, cash

def process_portfolio_positions(portfolio, cash, market_data):
    """Process portfolio positions and execute stop losses."""
    today_iso = last_trading_date().date().isoformat()
    results = []
    total_value = 0.0
    total_pnl = 0.0
    
    # Process each position
    for _, position in portfolio.iterrows():
        ticker = str(position["ticker"]).upper()
        shares = float(position["shares"]) if not pd.isna(position["shares"]) else 0
        buy_price = float(position["buy_price"]) if not pd.isna(position["buy_price"]) else 0.0
        cost_basis = float(position["cost_basis"]) if not pd.isna(position["cost_basis"]) else buy_price * shares
        stop_loss = float(position["stop_loss"]) if not pd.isna(position["stop_loss"]) else 0.0
        
        # Skip empty ticker rows
        if not ticker or ticker == "NAN":
            continue
        
        # Get market data for this ticker
        ticker_data = market_data.get(ticker, pd.DataFrame())
        
        if ticker_data.empty:
            result = {
                "Date": today_iso, "Ticker": ticker, "Shares": shares,
                "Buy Price": buy_price, "Cost Basis": cost_basis, "Stop Loss": stop_loss,
                "Current Price": "", "Total Value": "", "PnL": "",
                "Action": "NO DATA", "Cash Balance": "", "Total Equity": ""
            }
            results.append(result)
            continue
        
        # Get OHLC data
        latest_data = ticker_data.iloc[-1]
        open_price = latest_data.get("Open", latest_data.get("Close", 0))
        high_price = latest_data.get("High", latest_data.get("Close", 0))
        low_price = latest_data.get("Low", latest_data.get("Close", 0))
        close_price = latest_data.get("Close", 0)
        
        # Check for stop loss trigger
        if stop_loss > 0 and low_price <= stop_loss:
            exec_price = min(open_price, stop_loss) if open_price <= stop_loss else stop_loss
            exec_price = round(exec_price, 2)
            value = round(exec_price * shares, 2)
            pnl = round((exec_price - buy_price) * shares, 2)
            cash += value
            portfolio = portfolio[portfolio["ticker"] != ticker]
            
            result = {
                "Date": today_iso, "Ticker": ticker, "Shares": shares,
                "Buy Price": buy_price, "Cost Basis": cost_basis, "Stop Loss": stop_loss,
                "Current Price": exec_price, "Total Value": value, "PnL": pnl,
                "Action": "SELL - Stop Loss Triggered", "Cash Balance": "", "Total Equity": ""
            }
        else:
            current_price = round(close_price, 2)
            value = round(current_price * shares, 2)
            pnl = round((current_price - buy_price) * shares, 2)
            total_value += value
            total_pnl += pnl
            
            result = {
                "Date": today_iso, "Ticker": ticker, "Shares": shares,
                "Buy Price": buy_price, "Cost Basis": cost_basis, "Stop Loss": stop_loss,
                "Current Price": current_price, "Total Value": value, "PnL": pnl,
                "Action": "HOLD", "Cash Balance": "", "Total Equity": ""
            }
        
        results.append(result)
    
    # Add total row
    total_equity = total_value + cash
    total_row = {
        "Date": today_iso, "Ticker": "TOTAL", "Shares": "", "Buy Price": "",
        "Cost Basis": "", "Stop Loss": "", "Current Price": "",
        "Total Value": round(total_value, 2), "PnL": round(total_pnl, 2),
        "Action": "", "Cash Balance": round(cash, 2), "Total Equity": round(total_equity, 2)
    }
    results.append(total_row)
    
    return portfolio, cash, results

def calculate_performance_metrics(historical_df, current_results, market_data, sp500_df, starting_equity):
    """Calculate basic performance metrics."""
    today_iso = last_trading_date().date().isoformat()
    
    # Get current equity
    current_equity = 10000.0
    cash_balance = 0.0
    
    if current_results:
        total_row = next((r for r in current_results if r["Ticker"] == "TOTAL"), None)
        if total_row:
            current_equity = total_row.get("Total Equity", 10000.0)
            cash_balance = total_row.get("Cash Balance", 0.0)
    
    # Basic metrics
    return {
        "date": today_iso,
        "current_equity": current_equity,
        "cash_balance": cash_balance,
        "total_positions": len([r for r in current_results if r["Ticker"] != "TOTAL"]),
        "positions_with_data": len([r for r in current_results if r["Action"] != "NO DATA" and r["Ticker"] != "TOTAL"])
    }

# Execute the main function
return process_trading_portfolio()
