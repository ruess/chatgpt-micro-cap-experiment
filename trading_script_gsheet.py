"""
Portfolio Processing Node - Production Version
Receives classified data from Data Ingestion Node and processes portfolio.
STRICT MODE: No fallback data - requires real-time market data for all positions.
"""

import pandas as pd
import numpy as np
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

def process_trading_portfolio():
    """Main processing function that coordinates all modules."""
    try:
        # Get input data from Data Ingestion Node
        input_items = _input.all()
        
        # Check if we have any input
        if not input_items:
            return [{"json": {"error": "No input data received from Data Ingestion Node", "type": "error"}}]
        
        # Get the classified data from the first input item
        classified_input = input_items[0]['json']
        
        # Convert JS proxy to Python dict if needed
        if hasattr(classified_input, 'to_py'):
            classified_input = classified_input.to_py()
        elif not isinstance(classified_input, dict):
            classified_input = dict(classified_input)
        
        # Validate that we received classified data
        if classified_input.get("type") != "classified_data":
            return [{"json": {
                "error": f"Expected classified data from Data Ingestion Node, got type: {classified_input.get('type', 'unknown')}",
                "type": "error",
                "received_data": classified_input
            }}]
        
        # Extract classified data
        historical_portfolio = classified_input.get('historical_portfolio', [])
        current_market_data = classified_input.get('current_market_data', [])
        benchmark_data = classified_input.get('benchmark_data', [])
        sp500_data = classified_input.get('sp500_data', [])
        debug_info = classified_input.get('debug_info', {})
        
        # Data summary
        data_summary = {
            "historical_portfolio_count": len(historical_portfolio),
            "current_market_data_count": len(current_market_data),
            "benchmark_data_count": len(benchmark_data),
            "sp500_data_count": len(sp500_data),
            "market_tickers_found": [item['Ticker'] for item in current_market_data],
            "benchmark_tickers_found": [item['Ticker'] for item in benchmark_data]
        }
        
        # Check if we have the required data
        if not historical_portfolio:
            return [{"json": {
                "error": "No Google Sheets portfolio data found in classified input",
                "type": "error",
                "debug_info": debug_info,
                "data_summary": data_summary,
                "received_data_keys": list(classified_input.keys())
            }}]
        
        # Convert historical portfolio to DataFrame
        hist_df = pd.DataFrame(historical_portfolio)
        
        # Clean up the data - remove row_number column if present
        if 'row_number' in hist_df.columns:
            hist_df = hist_df.drop('row_number', axis=1)
        
        # Extract current portfolio state
        current_portfolio, cash_balance = extract_current_portfolio(hist_df)
        
        # STRICT MODE: Process ONLY real-time market data - NO FALLBACKS
        market_data_dict = {}
        for item in current_market_data:
            ticker = item['Ticker']
            df_data = {
                'Open': [item['Open']],
                'High': [item['High']], 
                'Low': [item['Low']],
                'Close': [item['Close']],
                'Volume': [item.get('Volume', 0)],
                'Date': [item['Date']],
                'HasIntradayData': [item.get('HasIntradayData', True)]
            }
            df = pd.DataFrame(df_data)
            df['Date'] = pd.to_datetime(df['Date'])
            df = df.set_index('Date')
            market_data_dict[ticker] = df
        
        # STRICT MODE: Validate that we have real-time data for ALL portfolio positions
        if current_portfolio is not None and not current_portfolio.empty:
            missing_data_tickers = []
            for _, position in current_portfolio.iterrows():
                ticker = str(position["ticker"]).upper()
                if ticker and ticker != "NAN" and ticker not in market_data_dict:
                    missing_data_tickers.append(ticker)
            
            # ERROR OUT if any positions lack real-time data
            if missing_data_tickers:
                return [{"json": {
                    "error": f"CRITICAL: Missing real-time market data for positions: {missing_data_tickers}",
                    "type": "error",
                    "missing_tickers": missing_data_tickers,
                    "available_market_data": list(market_data_dict.keys()),
                    "portfolio_tickers": [str(pos["ticker"]).upper() for _, pos in current_portfolio.iterrows()],
                    "data_summary": data_summary,
                    "help": "All portfolio positions must have real-time market data. Check DXFeed API connections."
                }}]
        
        # Process portfolio positions (now guaranteed to have real-time data)
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
            hist_df, portfolio_results, all_market_dict, sp500_df, 10000.0
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
            "data_quality": "REAL_TIME_ONLY",
            "success": True
        }})
        
        return results
        
    except Exception as e:
        import traceback
        return [{"json": {
            "error": f"Processing failed: {str(e)}", 
            "type": "error",
            "traceback": traceback.format_exc(),
            "input_data_available": len(input_items) if 'input_items' in locals() else 0
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
    updated_portfolio = portfolio.copy()
    
    # Process each position
    for idx, position in portfolio.iterrows():
        ticker = str(position["ticker"]).upper()
        shares = float(position["shares"]) if not pd.isna(position["shares"]) else 0
        buy_price = float(position["buy_price"]) if not pd.isna(position["buy_price"]) else 0.0
        cost_basis = float(position["cost_basis"]) if not pd.isna(position["cost_basis"]) else buy_price * shares
        stop_loss = float(position["stop_loss"]) if not pd.isna(position["stop_loss"]) else 0.0
        
        # Skip empty ticker rows
        if not ticker or ticker == "NAN":
            continue
        
        # Get market data for this ticker (guaranteed to exist due to validation above)
        ticker_data = market_data.get(ticker, pd.DataFrame())
        
        if ticker_data.empty:
            result = {
                "Date": today_iso, "Ticker": ticker, "Shares": shares,
                "Buy Price": buy_price, "Cost Basis": cost_basis, "Stop Loss": stop_loss,
                "Current Price": "", "Total Value": "", "PnL": "",
                "Action": "ERROR - NO REAL-TIME DATA", "Cash Balance": "", "Total Equity": ""
            }
            results.append(result)
            continue
        
        # Get OHLC data from real-time source
        latest_data = ticker_data.iloc[-1]
        open_price = latest_data.get("Open", latest_data.get("Close", 0))
        high_price = latest_data.get("High", latest_data.get("Close", 0))
        low_price = latest_data.get("Low", latest_data.get("Close", 0))  # REAL daily low for stop loss
        close_price = latest_data.get("Close", 0)
        
        # Check for stop loss trigger using REAL daily low
        if stop_loss > 0 and low_price <= stop_loss:
            exec_price = min(open_price, stop_loss) if open_price <= stop_loss else stop_loss
            exec_price = round(exec_price, 2)
            value = round(exec_price * shares, 2)
            pnl = round((exec_price - buy_price) * shares, 2)
            cash += value
            updated_portfolio = updated_portfolio[updated_portfolio["ticker"] != ticker]
            
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
    
    return updated_portfolio, cash, results

def calculate_performance_metrics(historical_df, current_results, market_data, sp500_df, starting_equity):
    """Calculate basic performance metrics."""
    today_iso = last_trading_date().date().isoformat()
    
    # Get current equity
    current_equity = starting_equity
    cash_balance = 0.0
    total_value = 0.0
    
    if current_results:
        total_row = next((r for r in current_results if r["Ticker"] == "TOTAL"), None)
        if total_row:
            current_equity = total_row.get("Total Equity", starting_equity)
            cash_balance = total_row.get("Cash Balance", 0.0)
            total_value = total_row.get("Total Value", 0.0)
    
    # Calculate performance metrics
    total_return = ((current_equity - starting_equity) / starting_equity) * 100 if starting_equity > 0 else 0.0
    
    # Get benchmark performance if available
    benchmark_performance = {}
    benchmarks = ['IWO', 'XBI', 'SPY', 'IWM']
    for benchmark in benchmarks:
        if benchmark in market_data:
            benchmark_df = market_data[benchmark]
            if not benchmark_df.empty:
                current_price = benchmark_df.iloc[-1]['Close']
                benchmark_performance[benchmark] = {
                    'current_price': current_price,
                    'ticker': benchmark
                }
    
    # Basic metrics
    return {
        "date": today_iso,
        "current_equity": current_equity,
        "cash_balance": cash_balance,
        "total_positions_value": total_value,
        "starting_equity": starting_equity,
        "total_return_percent": round(total_return, 2),
        "total_return_dollars": round(current_equity - starting_equity, 2),
        "total_positions": len([r for r in current_results if r["Ticker"] != "TOTAL"]),
        "positions_with_data": len([r for r in current_results if r["Action"] != "NO DATA" and r["Ticker"] != "TOTAL"]),
        "positions_on_hold": len([r for r in current_results if r["Action"] == "HOLD"]),
        "positions_sold": len([r for r in current_results if "SELL" in str(r.get("Action", ""))]),
        "benchmark_data": benchmark_performance
    }

# Execute the main function
return process_trading_portfolio()