"""Data fetching from SDMX and OWID APIs.

Supports fetching datasets from:
- SDMX: Eurostat, UN, World Bank, IMF, OECD, ECB
- OWID: Our World in Data GitHub datasets
"""

import logging
from pathlib import Path
from typing import Any, Dict, Optional

import requests
import pandas as pd

logger = logging.getLogger(__name__)


# SDMX provider configurations
SDMX_PROVIDERS = {
    "eurostat": {
        "name": "Eurostat",
        "url": "https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1",
        "format": "json",
        "description": "European Union statistics",
    },
    "unsd": {
        "name": "UN Statistics Division",
        "url": "https://data.un.org/ws/rest",
        "format": "json",
        "description": "United Nations global statistics",
    },
    "worldbank": {
        "name": "World Bank",
        "url": "https://api.worldbank.org/v2",
        "format": "json",
        "description": "World Bank development indicators",
    },
    "imf": {
        "name": "IMF",
        "url": "https://sdmx.oecd.org/public/rest",  # IMF uses OECD SDMX gateway
        "format": "json",
        "description": "International Monetary Fund data",
    },
    "oecd": {
        "name": "OECD",
        "url": "https://sdmx.oecd.org/public/rest",
        "format": "json",
        "description": "Organisation for Economic Co-operation and Development",
    },
    "ecb": {
        "name": "European Central Bank",
        "url": "https://data-api.ecb.europa.eu/service",
        "format": "json",
        "description": "European Central Bank statistics",
    },
}


class DataFetcher:
    """Fetch data from SDMX providers and OWID."""

    def __init__(self, workspace_dir: Path, timeout: int = 30):
        self.workspace_dir = workspace_dir
        self.timeout = timeout

    def list_providers(self) -> str:
        """List available SDMX data providers."""
        lines = ["**Available Data Providers**", ""]
        lines.append("| Provider | Name | Description |")
        lines.append("|----------|------|-------------|")
        for key, info in SDMX_PROVIDERS.items():
            lines.append(f"| {key} | {info['name']} | {info['description']} |")
        lines.append("")
        lines.append("Use `fetch_eurostat`, `fetch_worldbank`, or `fetch_owid` to retrieve data.")
        return "\n".join(lines)

    def fetch_eurostat(
        self,
        dataset_id: str,
        filters: Optional[Dict[str, str]] = None,
        start_period: Optional[str] = None,
        end_period: Optional[str] = None,
    ) -> str:
        """Fetch dataset from Eurostat.

        Args:
            dataset_id: Eurostat dataset code (e.g., 'nama_10_gdp', 'tour_occ_nim')
            filters: Dict of dimension filters (e.g., {'geo': 'DE+FR', 'unit': 'CP_MEUR'})
            start_period: Start year (e.g., '2010')
            end_period: End year (e.g., '2023')

        Returns:
            Confirmation message with file path
        """
        base_url = "https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/data"

        # Build filter string
        filter_str = "all" if not filters else ".".join(filters.get(k, "") for k in filters)

        url = f"{base_url}/{dataset_id}/{filter_str}"

        params = {"format": "SDMX-JSON", "compressed": "false"}
        if start_period:
            params["startPeriod"] = start_period
        if end_period:
            params["endPeriod"] = end_period

        try:
            response = requests.get(url, params=params, timeout=self.timeout)
            response.raise_for_status()
            data = response.json()

            # Parse SDMX-JSON structure
            df = self._parse_sdmx_json(data)

            if df.empty:
                return f"No data found for {dataset_id} with given filters"

            # Save to workspace
            filename = f"eurostat_{dataset_id}.csv"
            filepath = self.workspace_dir / filename
            df.to_csv(filepath, index=False)

            return (
                f"Fetched Eurostat dataset '{dataset_id}'\n"
                f"Saved to: {filename}\n"
                f"Rows: {len(df)}, Columns: {list(df.columns)}"
            )

        except requests.exceptions.HTTPError as e:
            return f"Error fetching Eurostat data: {e.response.status_code} - {e.response.reason}"
        except requests.exceptions.RequestException as e:
            return f"Error connecting to Eurostat: {str(e)}"
        except Exception as e:
            return f"Error processing Eurostat data: {str(e)}"

    def fetch_worldbank(
        self,
        indicator: str,
        countries: str = "all",
        start_year: Optional[int] = None,
        end_year: Optional[int] = None,
    ) -> str:
        """Fetch indicator data from World Bank.

        Args:
            indicator: World Bank indicator code (e.g., 'NY.GDP.MKTP.CD', 'SP.POP.TOTL')
            countries: Country codes, semicolon-separated (e.g., 'USA;DEU;FRA') or 'all'
            start_year: Start year
            end_year: End year

        Returns:
            Confirmation message with file path
        """
        base_url = "https://api.worldbank.org/v2"

        url = f"{base_url}/country/{countries}/indicator/{indicator}"

        params = {
            "format": "json",
            "per_page": 1000,
        }
        if start_year:
            params["date"] = f"{start_year}:{end_year or 2023}"

        try:
            response = requests.get(url, params=params, timeout=self.timeout)
            response.raise_for_status()
            data = response.json()

            # World Bank returns [metadata, data]
            if len(data) < 2 or not data[1]:
                return f"No data found for indicator {indicator}"

            records = data[1]
            df = pd.DataFrame([{
                "country": r["country"]["value"],
                "country_code": r["countryiso3code"],
                "year": r["date"],
                "value": r["value"],
                "indicator": r["indicator"]["value"],
            } for r in records if r.get("value") is not None])

            if df.empty:
                return f"No non-null data found for indicator {indicator}"

            # Save to workspace
            filename = f"worldbank_{indicator.replace('.', '_')}.csv"
            filepath = self.workspace_dir / filename
            df.to_csv(filepath, index=False)

            return (
                f"Fetched World Bank indicator '{indicator}'\n"
                f"Saved to: {filename}\n"
                f"Countries: {df['country'].nunique()}, Years: {df['year'].nunique()}, Rows: {len(df)}"
            )

        except requests.exceptions.HTTPError as e:
            return f"Error fetching World Bank data: {e.response.status_code}"
        except requests.exceptions.RequestException as e:
            return f"Error connecting to World Bank: {str(e)}"
        except Exception as e:
            return f"Error processing World Bank data: {str(e)}"

    def fetch_owid(self, dataset_name: str) -> str:
        """Fetch dataset from Our World in Data.

        Args:
            dataset_name: OWID dataset name (e.g., 'covid-19', 'life-expectancy', 'gdp-per-capita')

        Returns:
            Confirmation message with file path
        """
        # Try common URL patterns
        urls_to_try = [
            "https://covid.ourworldindata.org/data/owid-covid-data.csv",  # COVID special case
            f"https://raw.githubusercontent.com/owid/owid-datasets/master/datasets/{dataset_name}/{dataset_name}.csv",
            f"https://github.com/owid/owid-datasets/raw/master/datasets/{dataset_name}/{dataset_name}.csv",
        ]

        # For COVID data, use the direct URL
        if "covid" in dataset_name.lower():
            urls_to_try = ["https://covid.ourworldindata.org/data/owid-covid-data.csv"]

        for url in urls_to_try:
            try:
                response = requests.get(url, timeout=self.timeout)
                if response.status_code == 200:
                    # Save directly as CSV
                    filename = f"owid_{dataset_name.replace('-', '_')}.csv"
                    filepath = self.workspace_dir / filename
                    filepath.write_bytes(response.content)

                    # Read to get stats
                    df = pd.read_csv(filepath)

                    return (
                        f"Fetched OWID dataset '{dataset_name}'\n"
                        f"Saved to: {filename}\n"
                        f"Rows: {len(df)}, Columns: {list(df.columns)[:5]}..."
                    )
            except Exception:
                continue

        return (
            f"Could not find OWID dataset '{dataset_name}'\n"
            "Try: 'covid-19', 'life-expectancy', 'gdp-per-capita', 'population'\n"
            "Browse: https://github.com/owid/owid-datasets/tree/master/datasets"
        )

    def search_worldbank(self, query: str) -> str:
        """Search World Bank indicators.

        Args:
            query: Search term (e.g., 'GDP', 'population', 'education')

        Returns:
            List of matching indicators
        """
        url = "https://api.worldbank.org/v2/indicator"
        params = {"format": "json", "per_page": 20}

        try:
            response = requests.get(url, params=params, timeout=self.timeout)
            response.raise_for_status()
            data = response.json()

            if len(data) < 2 or not data[1]:
                return "No indicators found"

            # Filter by query
            query_lower = query.lower()
            matches = [
                ind for ind in data[1]
                if query_lower in ind["name"].lower() or query_lower in ind.get("sourceNote", "").lower()
            ]

            if not matches:
                return f"No indicators matching '{query}'"

            lines = [f"**World Bank Indicators matching '{query}'**", ""]
            lines.append("| Code | Name |")
            lines.append("|------|------|")
            for ind in matches[:15]:
                name = ind["name"][:60] + "..." if len(ind["name"]) > 60 else ind["name"]
                lines.append(f"| {ind['id']} | {name} |")

            if len(matches) > 15:
                lines.append(f"\n*...and {len(matches) - 15} more*")

            return "\n".join(lines)

        except Exception as e:
            return f"Error searching World Bank: {str(e)}"

    def _parse_sdmx_json(self, data: Dict[str, Any]) -> pd.DataFrame:
        """Parse SDMX-JSON format into a pandas DataFrame."""
        try:
            # SDMX-JSON structure: dataSets[0].series.{key: {observations}}
            if "dataSets" not in data or not data["dataSets"]:
                return pd.DataFrame()

            dataset = data["dataSets"][0]
            structure = data.get("structure", {})
            dimensions = structure.get("dimensions", {})

            # Get dimension names and codes
            dim_info = dimensions.get("series", []) + dimensions.get("observation", [])
            dim_names = {d["id"]: d for d in dim_info}

            records = []

            # Parse series
            if "series" in dataset:
                for series_key, series_data in dataset["series"].items():
                    # Parse series key dimensions
                    key_parts = series_key.split(":")
                    row = {}
                    for i, (dim_id, dim_meta) in enumerate(dim_names.items()):
                        if i < len(key_parts):
                            idx = int(key_parts[i])
                            values = dim_meta.get("values", [])
                            if idx < len(values):
                                row[dim_id] = values[idx].get("name", values[idx].get("id"))

                    # Parse observations
                    obs = series_data.get("observations", {})
                    for time_idx, values in obs.items():
                        obs_row = row.copy()
                        # Get time dimension value
                        time_dims = dimensions.get("observation", [])
                        if time_dims:
                            time_values = time_dims[0].get("values", [])
                            if int(time_idx) < len(time_values):
                                obs_row["time"] = time_values[int(time_idx)].get("id")
                        obs_row["value"] = values[0] if values else None
                        records.append(obs_row)

            return pd.DataFrame(records)

        except Exception as e:
            logger.error("Error parsing SDMX-JSON: %s", e)
            return pd.DataFrame()
